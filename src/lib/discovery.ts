import Database from "better-sqlite3";
import { getDb, getPollState, setPollState } from "./url-index";
import { fetchWithTimeout } from "./fetch";
import { skeleton, dexPairCreatedMs } from "./normalize";

/**
 * Discovery registry: every token the poller sees lands in discovered_tokens,
 * named or not. Unnamed mints get a cheap DexScreener batch name-resolution
 * pass on later ticks. recordDiscoveredTokens returns the future alertable
 * set — rows that are new-and-named or newly-named this call.
 *
 * Every export swallows failures ([] / no-op) — discovery is best-effort and
 * must never kill a poller tick or a request.
 */

const TOKENS_V1 = "https://api.dexscreener.com/tokens/v1/solana";
const DEX_TIMEOUT = 10_000;
/** Max items per recordDiscoveredTokens call (one bounded transaction). */
const MAX_RECORD_BATCH = 500;
/** DexScreener tokens/v1 accepts up to ~30 mints; match dex-social's 25. */
const RESOLVE_CHUNK = 25;
/** Max tokens/v1 batches per resolveNamesViaDex call. */
const RESOLVE_MAX_CHUNKS = 2;
const UNNAMED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface DiscoveryInput {
  mint: string;
  name?: string;
  symbol?: string;
  pairCreatedAtMs?: number;
}

/** A token that became alertable this call: new-and-named or newly-named. */
export interface NewDiscovery {
  mint: string;
  name: string;
  symbol: string | null;
  /** skeleton(name), or null when the name is empty after folding. */
  nameSkeleton: string | null;
  source: string;
  pairCreatedAtMs: number | null;
}

let existingNameStmt: Database.Statement | null = null;
let discoveryUpsertStmt: Database.Statement | null = null;

function getExistingNameStmt(): Database.Statement {
  if (!existingNameStmt) {
    existingNameStmt = getDb().prepare(
      "SELECT name FROM discovered_tokens WHERE mint = ?"
    );
  }
  return existingNameStmt;
}

function getDiscoveryUpsertStmt(): Database.Statement {
  if (!discoveryUpsertStmt) {
    // First-seen wins everywhere: name/symbol/skeleton/named_at/pair_created_at
    // only fill in NULLs; source and first_seen_at are never overwritten.
    discoveryUpsertStmt = getDb().prepare(`
      INSERT INTO discovered_tokens
        (mint, name, symbol, name_skeleton, source, first_seen_at, named_at, pair_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        name            = COALESCE(discovered_tokens.name, excluded.name),
        symbol          = COALESCE(discovered_tokens.symbol, excluded.symbol),
        name_skeleton   = COALESCE(discovered_tokens.name_skeleton, excluded.name_skeleton),
        named_at        = COALESCE(discovered_tokens.named_at, excluded.named_at),
        pair_created_at = COALESCE(discovered_tokens.pair_created_at, excluded.pair_created_at)
    `);
  }
  return discoveryUpsertStmt;
}

/**
 * Upsert discovered tokens in one transaction (input capped at 500).
 * Returns the rows that are NEW-and-named or NEWLY-NAMED by this call —
 * each such row is returned exactly once across calls. Failures return [].
 */
export function recordDiscoveredTokens(
  items: DiscoveryInput[],
  source: string
): NewDiscovery[] {
  try {
    const capped = items.slice(0, MAX_RECORD_BATCH);
    if (capped.length === 0) return [];
    const existingStmt = getExistingNameStmt();
    const upsert = getDiscoveryUpsertStmt();
    const out: NewDiscovery[] = [];
    const tx = getDb().transaction(() => {
      const now = Date.now();
      for (const item of capped) {
        if (!item.mint) continue;
        const name = item.name?.trim() ? item.name : null;
        const symbol = item.symbol?.trim() ? item.symbol : null;
        const nameSkeleton = name ? skeleton(name) || null : null;
        const pairCreatedAt =
          typeof item.pairCreatedAtMs === "number" &&
          Number.isFinite(item.pairCreatedAtMs)
            ? item.pairCreatedAtMs
            : null;
        // Pre-check: which mints exist and whether they are still unnamed —
        // that is what makes a named upsert "newly named" below.
        const existing = existingStmt.get(item.mint) as
          | { name: string | null }
          | undefined;
        upsert.run(
          item.mint,
          name,
          symbol,
          nameSkeleton,
          source,
          now,
          name ? now : null,
          pairCreatedAt
        );
        if (name && (!existing || existing.name === null)) {
          out.push({
            mint: item.mint,
            name,
            symbol,
            nameSkeleton,
            source,
            pairCreatedAtMs: pairCreatedAt,
          });
        }
      }
    });
    tx();
    return out;
  } catch {
    return [];
  }
}

/** Unnamed mints first seen within the last 24h, oldest first. */
export function getUnnamedRecentMints(n = 50): string[] {
  try {
    const cutoff = Date.now() - UNNAMED_LOOKBACK_MS;
    const rows = getDb()
      .prepare(
        `SELECT mint FROM discovered_tokens
         WHERE name IS NULL AND first_seen_at >= ?
         ORDER BY first_seen_at ASC
         LIMIT ?`
      )
      .all(cutoff, n) as { mint: string }[];
    return rows.map((r) => r.mint);
  } catch {
    return [];
  }
}

/**
 * Resolve names for mints via DexScreener tokens/v1 batches (25 mints per
 * call, max 2 calls). Only pairs that actually carry a base-token name are
 * returned. Failures skip the chunk.
 */
export async function resolveNamesViaDex(
  mints: string[]
): Promise<DiscoveryInput[]> {
  const out: DiscoveryInput[] = [];
  const unique = Array.from(new Set(mints)).slice(
    0,
    RESOLVE_CHUNK * RESOLVE_MAX_CHUNKS
  );
  for (let i = 0; i < unique.length; i += RESOLVE_CHUNK) {
    const chunk = unique.slice(i, i + RESOLVE_CHUNK);
    const url = `${TOKENS_V1}/${chunk.join(",")}`;
    try {
      const pairs = (await fetchWithTimeout(url, DEX_TIMEOUT)) as Array<{
        chainId: string;
        baseToken?: { address?: string; name?: string; symbol?: string };
        pairCreatedAt?: number;
      }> | null;
      if (!Array.isArray(pairs)) continue;
      for (const p of pairs) {
        if (p.chainId !== "solana") continue;
        const mint = p.baseToken?.address;
        if (!mint || !p.baseToken?.name) continue;
        out.push({
          mint,
          name: p.baseToken.name,
          symbol: p.baseToken.symbol,
          pairCreatedAtMs: dexPairCreatedMs(p.pairCreatedAt),
        });
      }
    } catch {
      /* skip chunk */
    }
  }
  return out;
}

/** Drop rows older than 14 days. Throttled to once per hour via poll_state. */
export function pruneDiscoveredTokens(): void {
  try {
    const now = Date.now();
    const last = Number(getPollState("discovered:prune_at") ?? 0);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return;
    setPollState("discovered:prune_at", String(now));
    getDb()
      .prepare("DELETE FROM discovered_tokens WHERE first_seen_at < ?")
      .run(now - PRUNE_MAX_AGE_MS);
  } catch {
    /* prune is best-effort */
  }
}
