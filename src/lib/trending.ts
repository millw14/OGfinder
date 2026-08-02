import Database from "better-sqlite3";
import { getDb } from "./url-index";
import {
  DexPairSocial,
  fetchTokenPairsBatched,
  pairBeats,
} from "./dex-social";

/**
 * Trending copycat clusters: groups the discovery firehose by name skeleton
 * to surface names being launched over and over. DB clustering is sync and
 * best-effort (failures → empty list); market data is a single batched
 * DexScreener tokens/v1 pass for the top clusters only (failures → null
 * fields). Results are cached 60s per window with in-flight coalescing.
 */

export type TrendingWindow = "24h" | "7d";

const WINDOW_MS: Record<TrendingWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const CACHE_TTL_MS = 60_000;
/** Minimum skeleton length — shorter keys cluster unrelated names. */
const MIN_SKELETON_LEN = 3;
/** Minimum launches in-window for a skeleton to count as a cluster. */
const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTERS = 20;
const MEMBERS_PER_CLUSTER = 5;
/** Only the top clusters get market data — caps the mint batch at 8*5=40. */
const MARKET_DATA_CLUSTERS = 8;

export interface TrendingClusterMember {
  mint: string;
  name: string | null;
  symbol: string | null;
  firstSeenAt: number;
}

export interface TrendingCluster {
  skeleton: string;
  /** Most frequent raw name among the top members. */
  representativeName: string;
  representativeSymbol: string | null;
  launches: number;
  /** MIN(COALESCE(pair_created_at, first_seen_at)) across the cluster. */
  oldestKnownMs: number;
  newestSeenMs: number;
  /** Top members, newest-first. */
  members: TrendingClusterMember[];
  /** Aggregate marketCap ?? fdv across members; null when no data. */
  marketCapUsd: number | null;
  volumeUsd24h: number | null;
}

export interface TrendingResult {
  window: TrendingWindow;
  generatedAt: number;
  clusters: TrendingCluster[];
}

let clusterStmt: Database.Statement | null = null;
let membersStmt: Database.Statement | null = null;

function getClusterStmt(): Database.Statement {
  if (!clusterStmt) {
    clusterStmt = getDb().prepare(`
      SELECT name_skeleton AS skeleton,
             COUNT(*) AS launches,
             MIN(COALESCE(pair_created_at, first_seen_at)) AS oldest_known_ms,
             MAX(first_seen_at) AS newest_seen_ms
      FROM discovered_tokens
      WHERE first_seen_at > ?
        AND name_skeleton IS NOT NULL
        AND length(name_skeleton) >= ${MIN_SKELETON_LEN}
      GROUP BY name_skeleton
      HAVING COUNT(*) >= ${MIN_CLUSTER_SIZE}
      ORDER BY launches DESC
      LIMIT ${MAX_CLUSTERS}
    `);
  }
  return clusterStmt;
}

function getMembersStmt(): Database.Statement {
  if (!membersStmt) {
    membersStmt = getDb().prepare(`
      SELECT mint, name, symbol, first_seen_at
      FROM discovered_tokens
      WHERE name_skeleton = ? AND first_seen_at > ?
      ORDER BY first_seen_at DESC
      LIMIT ${MEMBERS_PER_CLUSTER}
    `);
  }
  return membersStmt;
}

/** Most frequent raw name among members; ties → newest occurrence wins. */
function pickRepresentative(members: TrendingClusterMember[]): {
  name: string;
  symbol: string | null;
} {
  const counts = new Map<string, number>();
  for (const m of members) {
    if (!m.name) continue;
    counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const m of members) {
    if (!m.name) continue;
    const c = counts.get(m.name) ?? 0;
    if (c > bestCount) {
      best = m.name;
      bestCount = c;
    }
  }
  if (best === null) {
    // Skeleton-clustered members always carry names in practice; fall back
    // to the skeleton-less-safe empty representative just in case.
    return { name: "", symbol: null };
  }
  const carrier = members.find((m) => m.name === best);
  return { name: best, symbol: carrier?.symbol ?? null };
}

/**
 * Sync DB clustering pass (market fields null). Exported for tests.
 * Failures return [] — trending must never break a request.
 */
export function queryTrendingClusters(
  window: TrendingWindow
): TrendingCluster[] {
  try {
    const cutoff = Date.now() - WINDOW_MS[window];
    const rows = getClusterStmt().all(cutoff) as {
      skeleton: string;
      launches: number;
      oldest_known_ms: number;
      newest_seen_ms: number;
    }[];
    const members = getMembersStmt();
    return rows.map((row) => {
      const memberRows = members.all(row.skeleton, cutoff) as {
        mint: string;
        name: string | null;
        symbol: string | null;
        first_seen_at: number;
      }[];
      const clusterMembers: TrendingClusterMember[] = memberRows.map((m) => ({
        mint: m.mint,
        name: m.name,
        symbol: m.symbol,
        firstSeenAt: m.first_seen_at,
      }));
      const rep = pickRepresentative(clusterMembers);
      return {
        skeleton: row.skeleton,
        representativeName: rep.name,
        representativeSymbol: rep.symbol,
        launches: row.launches,
        oldestKnownMs: row.oldest_known_ms,
        newestSeenMs: row.newest_seen_ms,
        members: clusterMembers,
        marketCapUsd: null,
        volumeUsd24h: null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * One batched tokens/v1 pass for the top clusters' member mints: best pair
 * per mint, then per-cluster sums. Mutates the passed clusters in place.
 */
async function attachMarketData(clusters: TrendingCluster[]): Promise<void> {
  const top = clusters.slice(0, MARKET_DATA_CLUSTERS);
  const mints = top.flatMap((c) => c.members.map((m) => m.mint));
  if (mints.length === 0) return;
  try {
    const pairs = await fetchTokenPairsBatched(mints);
    const bestByMint = new Map<string, DexPairSocial>();
    for (const p of pairs) {
      if (p.chainId !== "solana") continue;
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const prev = bestByMint.get(mint);
      if (!prev || pairBeats(p, prev)) bestByMint.set(mint, p);
    }
    for (const c of top) {
      let mc = 0;
      let vol = 0;
      let found = false;
      for (const m of c.members) {
        const p = bestByMint.get(m.mint);
        if (!p) continue;
        found = true;
        mc += p.marketCap ?? p.fdv ?? 0;
        vol += p.volume?.h24 ?? 0;
      }
      if (found) {
        c.marketCapUsd = mc;
        c.volumeUsd24h = vol;
      }
    }
  } catch {
    /* market data is best-effort — fields stay null */
  }
}

async function computeTrendingClusters(
  window: TrendingWindow
): Promise<TrendingResult> {
  const clusters = queryTrendingClusters(window);
  await attachMarketData(clusters);
  return { window, generatedAt: Date.now(), clusters };
}

const cache = new Map<
  TrendingWindow,
  { value: TrendingResult; expiresAt: number }
>();
const inFlight = new Map<TrendingWindow, Promise<TrendingResult>>();

export async function getTrendingClusters(
  window: TrendingWindow
): Promise<TrendingResult> {
  const cached = cache.get(window);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = inFlight.get(window);
  if (existing) return existing;
  const p = computeTrendingClusters(window)
    .then((value) => {
      cache.set(window, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      inFlight.delete(window);
    });
  inFlight.set(window, p);
  return p;
}
