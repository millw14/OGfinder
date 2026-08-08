import { getDb } from "./url-index";
import { skeleton } from "./normalize";
import { ageOrderConfidence } from "./sort";
import type { TokenResult } from "./types";
import type { MintScanPayload } from "./scan";

/**
 * Exact-name OG registry: remembers the verified OG of a FULL name so repeat
 * scans (Telegram groups paste the same ~100 CAs/day) answer instantly.
 *
 * THE KEY RULE — keys are the exact skeleton() of the FULL display name.
 * "Trump", "Trump Coin", and "Trump Inu" are three DIFFERENT names with three
 * different registry entries. A scan of "Trump Coin" must never read or write
 * the "trump" entry, and the oldest "trump <anything>" token must never be
 * registered as the OG of "trump" — candidate matching is skeleton EQUALITY,
 * never includes/prefix.
 *
 * Only certain ages are immortalized: an OG whose age is a lower bound
 * (truncated signature scan), still pending, missing, or whose name only
 * matches via homoglyph folding is never written — nor is one whose LEAD is
 * unprovable, i.e. a same-name token ranked below it still carries a
 * lower-bound age that could predate it.
 *
 * AND ONLY SAFE-ENOUGH TOKENS. A registered OG is served as an instant verdict
 * to every Telegram group for 24h, so a token carrying a blocking safety flag
 * is never written — and if one is already registered, it is evicted the
 * moment we assess it as dangerous.
 */

/** Registry answers older than this are stale — fall back to a full scan. */
export const REGISTRY_FRESH_MS = 24 * 60 * 60 * 1000;

export interface OgRegistryEntry {
  ogMint: string;
  ogName: string;
  ogSymbol: string | null;
  ogCreatedAtMs: number | null;
  verifiedAt: number;
  scanCount: number;
}

/** True while a registry entry is inside the freshness window. */
export function isRegistryFresh(verifiedAt: number, now = Date.now()): boolean {
  return now - verifiedAt < REGISTRY_FRESH_MS;
}

/**
 * Remove a mint from the registry wherever it is the registered OG. Returns
 * the number of rows deleted. Never throws (registry work is best-effort).
 */
export function evictOgMint(mint: string): number {
  try {
    const info = getDb()
      .prepare(`DELETE FROM og_registry WHERE og_mint = ?`)
      .run(mint);
    return info.changes ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Record the resolved OG of a completed FULL mint scan. Key = exact skeleton
 * of the SCANNED token's display name; the OG is the oldest (lowest-rank)
 * result whose name skeleton EXACTLY equals that key. If that candidate's age
 * is uncertain (pending / lower bound / missing), its name is homoglyph-
 * suspect, or it carries a blocking safety flag, nothing is written — we never
 * fall through to a younger candidate.
 * Best-effort: every failure is swallowed (must never break a scan).
 */
export function recordOgFromScan(
  payload: MintScanPayload,
  scannedMint: string
): void {
  try {
    // Eviction first, and independent of everything below: a token we have
    // now assessed as dangerous must not keep serving instant "this is the
    // OG" verdicts from a row written before the flag existed.
    for (const t of payload.results) {
      if (t.safetyLevel === "danger") evictOgMint(t.mint);
    }

    const scanned = payload.results.find((t) => t.mint === scannedMint);
    const scannedName = scanned?.displayName ?? payload.scanName;
    if (!scannedName) return;
    const key = skeleton(scannedName);
    if (key.length < 2) return;

    // EXACT skeleton equality only — "trump coin" never touches "trump".
    const sameName: TokenResult[] = [];
    let og: TokenResult | undefined;
    for (const t of payload.results) {
      if (skeleton(t.displayName) !== key) continue;
      sameName.push(t);
      if (og === undefined || t.rank < og.rank) og = t;
    }
    if (!og) return;
    // An entry here is served as "the OG of <name>" for 24h, so the ORDER has
    // to be provable, not just the candidate's own date: a same-name token
    // ranked below it whose age is still a lower bound could predate it. The
    // check runs over the same-name subset only — a truncated token called
    // something else cannot contest THIS key. (sameName is already in rank
    // order, so its [0] is `og`.)
    if (!ageOrderConfidence(sameName).proven) return;
    // Uncertain age must not be immortalized as "the OG of <name>".
    if (og.createdAtMs == null) return;
    if (og.pendingAge) return;
    if (og.createdAtIsLowerBound) return;
    if (og.homoglyphSuspect) return;
    // A blocking safety flag bars the crown (sort.ts) — it must bar the
    // registry too, or the honeypot gets cemented for 24h. We never fall
    // through to a younger candidate: the key simply stays empty and the next
    // caller pays for a full scan.
    if (og.safetyLevel === "danger") return;

    getDb()
      .prepare(
        `INSERT INTO og_registry
           (name_skeleton, og_mint, og_name, og_symbol, og_created_at_ms, verified_at, scan_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(name_skeleton) DO UPDATE SET
           og_mint          = excluded.og_mint,
           og_name          = excluded.og_name,
           og_symbol        = excluded.og_symbol,
           og_created_at_ms = excluded.og_created_at_ms,
           verified_at      = excluded.verified_at,
           scan_count       = og_registry.scan_count + 1`
      )
      .run(
        key,
        og.mint,
        og.displayName,
        og.displaySymbol || null,
        og.createdAtMs,
        Date.now()
      );
  } catch {
    /* registry is best-effort — never breaks a scan */
  }
}

/** Look up the registered OG for an exact name skeleton. Never throws. */
export function getRegisteredOg(
  nameSkeleton: string
): OgRegistryEntry | undefined {
  try {
    const row = getDb()
      .prepare(
        `SELECT og_mint, og_name, og_symbol, og_created_at_ms, verified_at, scan_count
         FROM og_registry WHERE name_skeleton = ?`
      )
      .get(nameSkeleton) as
      | {
          og_mint: string;
          og_name: string;
          og_symbol: string | null;
          og_created_at_ms: number | null;
          verified_at: number;
          scan_count: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      ogMint: row.og_mint,
      ogName: row.og_name,
      ogSymbol: row.og_symbol,
      ogCreatedAtMs: row.og_created_at_ms,
      verifiedAt: row.verified_at,
      scanCount: row.scan_count,
    };
  } catch {
    return undefined;
  }
}
