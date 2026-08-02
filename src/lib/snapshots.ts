import { getDb, getPollState, setPollState } from "./url-index";
import { skeleton } from "./normalize";
import { recordFlipAlert } from "./watches";
import type { FlipInfo, SearchHistory, TokenResult } from "./types";

/**
 * OG-flip history: every cold full text search stores a top-10 leaderboard
 * snapshot per normalized query. Comparing the newest two snapshots yields a
 * flip verdict — did a copycat overtake the OG (the older snapshot's rank-1
 * token) on market cap, or liquidity as a fallback? Metrics are only compared
 * when BOTH the OG and the challenger carry the metric in BOTH snapshots, and
 * never mixed: if market cap is comparable, its verdict is final.
 *
 * Every export swallows SQLite failures — snapshots are best-effort and must
 * never break a search request or a poller tick.
 */

/** Skip capture when the latest snapshot for the query is younger than this. */
const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** Leaderboard entries stored per snapshot. */
const SNAPSHOT_TOP_N = 10;
/** Newest snapshots kept per query. */
const SNAPSHOTS_KEPT_PER_QUERY = 20;
/** Global retention for query_snapshots rows. */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Prune throttle (poll_state-gated, poller calls every tick). */
const SNAPSHOT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** One stored leaderboard row. Nullable fields stay null — never coerced. */
interface SnapshotEntry {
  mint: string;
  rank: number;
  name: string;
  symbol: string;
  createdAtMs: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
}

interface SnapshotRow {
  taken_at: number;
  rank1_mint: string;
  top_json: string;
}

// captureSnapshot and detectAndRecordFlip are called back-to-back
// synchronously from the search route; this one-shot marker links them so a
// flip alert can only fire when a snapshot was ACTUALLY just inserted —
// repeated searches between captures must not re-insert alerts.
let justCapturedQuery: string | null = null;

/**
 * Store a top-10 leaderboard snapshot for a normalized text query. Skips when
 * results are empty, when the rank-1 token has no creation time (no OG to
 * track), or when the latest snapshot is under 30 minutes old. Keeps the
 * newest 20 snapshots per query.
 */
export function captureSnapshot(
  queryNorm: string,
  results: TokenResult[]
): void {
  try {
    if (results.length === 0) return;
    if (results[0].createdAtMs == null) return;
    const db = getDb();
    const now = Date.now();
    const latest = db
      .prepare(
        `SELECT taken_at FROM query_snapshots
         WHERE query_norm = ? ORDER BY taken_at DESC LIMIT 1`
      )
      .get(queryNorm) as { taken_at: number } | undefined;
    if (latest && now - latest.taken_at < SNAPSHOT_MIN_INTERVAL_MS) return;

    const top: SnapshotEntry[] = results
      .slice(0, SNAPSHOT_TOP_N)
      .map((t, i) => ({
        mint: t.mint,
        rank: t.rank > 0 ? t.rank : i + 1,
        name: t.displayName,
        symbol: t.displaySymbol,
        createdAtMs: t.createdAtMs ?? null,
        marketCapUsd: t.marketCapUsd ?? null,
        priceUsd: t.priceUsd ?? null,
        liquidityUsd: t.liquidityUsd ?? null,
      }));

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO query_snapshots (query_norm, taken_at, rank1_mint, top_json)
         VALUES (?, ?, ?, ?)`
      ).run(queryNorm, now, results[0].mint, JSON.stringify(top));
      db.prepare(
        `DELETE FROM query_snapshots WHERE query_norm = ? AND id NOT IN (
           SELECT id FROM query_snapshots WHERE query_norm = ?
           ORDER BY taken_at DESC, id DESC LIMIT ?)`
      ).run(queryNorm, queryNorm, SNAPSHOTS_KEPT_PER_QUERY);
    });
    tx();
    justCapturedQuery = queryNorm;
  } catch {
    /* snapshots are best-effort */
  }
}

function parseEntries(json: string): SnapshotEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SnapshotEntry[]) : null;
  } catch {
    return null;
  }
}

const METRICS = [
  ["marketCapUsd", "marketcap"],
  ["liquidityUsd", "liquidity"],
] as const;

/**
 * Flip verdict between two snapshots. OG = the OLDER snapshot's rank-1 mint.
 * Metric selection: market cap when the OG and at least one challenger carry
 * it in both snapshots; otherwise liquidity under the same rule; otherwise no
 * verdict. Once a metric is comparable its verdict is final (never mixed) —
 * an OG leading on market cap is never re-judged on liquidity.
 */
function compareSnapshots(
  older: SnapshotRow,
  newer: SnapshotRow
): FlipInfo | null {
  const oldEntries = parseEntries(older.top_json);
  const newEntries = parseEntries(newer.top_json);
  if (!oldEntries || !newEntries) return null;
  const ogMint = older.rank1_mint;

  for (const [key, metric] of METRICS) {
    const ogOld = oldEntries.find((e) => e.mint === ogMint);
    const ogNew = newEntries.find((e) => e.mint === ogMint);
    if (ogOld?.[key] == null || ogNew?.[key] == null) continue;

    // Challengers must carry the metric in BOTH snapshots to be comparable.
    const comparable = (e: SnapshotEntry, other: SnapshotEntry[]): boolean =>
      e.mint !== ogMint &&
      e[key] != null &&
      other.some((o) => o.mint === e.mint && o[key] != null);
    const newCands = newEntries.filter((e) => comparable(e, oldEntries));
    if (newCands.length === 0) continue;

    const top = newCands.reduce((a, b) => (b[key]! > a[key]! ? b : a));
    const og = { mint: ogMint, name: ogNew.name, value: ogNew[key]! };
    if (top[key]! > ogNew[key]!) {
      return {
        flipped: true,
        at: newer.taken_at,
        metric,
        og,
        challenger: { mint: top.mint, name: top.name, value: top[key]! },
      };
    }

    // OG leads now — did a comparable challenger lead in the OLDER snapshot?
    const oldCands = oldEntries.filter((e) => comparable(e, newEntries));
    const oldTop =
      oldCands.length > 0
        ? oldCands.reduce((a, b) => (b[key]! > a[key]! ? b : a))
        : null;
    if (oldTop && oldTop[key]! > ogOld[key]!) {
      const chNew = newEntries.find((e) => e.mint === oldTop.mint);
      if (chNew?.[key] != null) {
        return {
          flipped: false,
          reclaimed: true,
          at: newer.taken_at,
          metric,
          og,
          challenger: { mint: chNew.mint, name: chNew.name, value: chNew[key]! },
        };
      }
    }
    // Metric comparable, OG led throughout — final verdict, no fallback.
    return null;
  }
  return null;
}

/**
 * Snapshot history for a query: count, first snapshot time, and the flip
 * verdict from the newest two snapshots. Null when the query has no
 * snapshots (or on DB failure) — cheap indexed reads either way.
 */
export function getSearchHistory(queryNorm: string): SearchHistory | null {
  try {
    const db = getDb();
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS cnt, MIN(taken_at) AS first
         FROM query_snapshots WHERE query_norm = ?`
      )
      .get(queryNorm) as { cnt: number; first: number | null } | undefined;
    if (!agg || agg.cnt === 0 || agg.first == null) return null;
    let flip: FlipInfo | null = null;
    if (agg.cnt >= 2) {
      const rows = db
        .prepare(
          `SELECT taken_at, rank1_mint, top_json FROM query_snapshots
           WHERE query_norm = ? ORDER BY taken_at DESC, id DESC LIMIT 2`
        )
        .all(queryNorm) as SnapshotRow[];
      if (rows.length === 2) flip = compareSnapshots(rows[1], rows[0]);
    }
    return { snapshotCount: agg.cnt, firstSnapshotAt: agg.first, flip };
  } catch {
    return null;
  }
}

/**
 * After a capture, insert kind='flip' alerts for watches matching the query's
 * skeleton — only when captureSnapshot JUST inserted a snapshot (one-shot
 * marker) AND the flip is NEW: the previous snapshot pair did not already
 * show the same challenger ahead. Reclaims never alert.
 */
export function detectAndRecordFlip(queryNorm: string): void {
  try {
    if (justCapturedQuery !== queryNorm) return;
    justCapturedQuery = null;
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT taken_at, rank1_mint, top_json FROM query_snapshots
         WHERE query_norm = ? ORDER BY taken_at DESC, id DESC LIMIT 3`
      )
      .all(queryNorm) as SnapshotRow[];
    if (rows.length < 2) return;
    const current = compareSnapshots(rows[1], rows[0]);
    if (!current?.flipped) return;
    if (rows.length >= 3) {
      const prev = compareSnapshots(rows[2], rows[1]);
      if (prev?.flipped && prev.challenger.mint === current.challenger.mint) {
        return; // same flip already alerted on an earlier capture
      }
    }
    recordFlipAlert(skeleton(queryNorm), {
      name: current.challenger.name,
      payload: current,
    });
  } catch {
    /* flip alerts are best-effort */
  }
}

/**
 * Global 30-day prune of query_snapshots, throttled to once per hour via
 * poll_state. Called from the poller's maintenance step.
 */
export function pruneSnapshots(): void {
  try {
    const now = Date.now();
    const last = Number(getPollState("snapshots:prune_at") ?? 0);
    if (Number.isFinite(last) && now - last < SNAPSHOT_PRUNE_INTERVAL_MS) {
      return;
    }
    setPollState("snapshots:prune_at", String(now));
    getDb()
      .prepare("DELETE FROM query_snapshots WHERE taken_at < ?")
      .run(now - SNAPSHOT_RETENTION_MS);
  } catch {
    /* prune is best-effort */
  }
}
