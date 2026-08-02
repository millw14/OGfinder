import { TokenResult } from "./types";
import { getLinksForMints, MintLinkRow } from "./url-index";

/**
 * Social-link provenance: which token was the EARLIEST claimant of a contested
 * social/website URL, per OGfinder's own link index.
 *
 * Honesty note (load-bearing): token_links.discovered_at is when OUR poller
 * first observed a link — never when the link was created or first posted. The
 * index only covers recently listed tokens, so a missing flag proves nothing,
 * and the scanned token NOT being the earliest claimant is never surfaced.
 */

/**
 * The earliest claimant must lead the runner-up by at least 1h — filters
 * same-poll-tick and index-inception clusters where observed order is noise.
 */
export const MIN_LEAD_MS = 3_600_000;

/** How many top-ranked results (plus the scanned mint) get provenance checks. */
export const MAX_PROVENANCE_RANKED = 25;

/** Mints considered for provenance: scanned + the first 25 ranked, deduped. */
export function provenanceMints(
  results: TokenResult[],
  scannedMint: string
): string[] {
  const mints = new Set<string>([scannedMint]);
  for (const t of results.slice(0, MAX_PROVENANCE_RANKED)) mints.add(t.mint);
  return Array.from(mints);
}

/**
 * Pure core: group rows by url_norm; contested URLs have >=2 distinct mints.
 * Each contested URL's earliest claimant is flagged only when it leads the
 * second-earliest claimant by MIN_LEAD_MS+. A token leading several contested
 * URLs keeps the one with the largest lead. Mutates results in place;
 * non-earliest claimants stay untouched (never claim the negative).
 */
export function applyLinkProvenance(
  results: TokenResult[],
  rows: MintLinkRow[]
): void {
  if (rows.length === 0) return;

  const byUrl = new Map<string, MintLinkRow[]>();
  for (const row of rows) {
    const group = byUrl.get(row.url_norm);
    if (group) group.push(row);
    else byUrl.set(row.url_norm, [row]);
  }

  const bestByMint = new Map<
    string,
    NonNullable<TokenResult["linkProvenance"]>
  >();
  for (const [url, group] of byUrl) {
    const distinctMints = new Set(group.map((r) => r.mint));
    if (distinctMints.size < 2) continue; // uncontested — nothing to say
    group.sort((a, b) => a.discovered_at - b.discovered_at);
    const leader = group[0];
    const runnerUp = group.find((r) => r.mint !== leader.mint)!;
    const leadMs = runnerUp.discovered_at - leader.discovered_at;
    if (leadMs < MIN_LEAD_MS) continue; // same-tick / inception cluster
    const prev = bestByMint.get(leader.mint);
    if (!prev || leadMs > prev.leadMs) {
      bestByMint.set(leader.mint, {
        url,
        firstSeenMs: leader.discovered_at,
        rivalCount: distinctMints.size - 1,
        leadMs,
      });
    }
  }
  if (bestByMint.size === 0) return;

  for (const token of results) {
    const claim = bestByMint.get(token.mint);
    if (claim) token.linkProvenance = claim;
  }
}

/**
 * Annotate scan results with earliest-link-claim evidence (mutates in place).
 * Sub-ms local SQLite read; any failure leaves results untouched.
 */
export function annotateLinkProvenance(
  results: TokenResult[],
  scannedMint: string
): void {
  try {
    const rows = getLinksForMints(provenanceMints(results, scannedMint));
    applyLinkProvenance(results, rows);
  } catch {
    // Provenance is best-effort — never fail a scan over it.
  }
}
