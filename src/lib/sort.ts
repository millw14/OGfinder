import { TokenResult } from "./types";
import { normalize } from "./normalize";

export function sortByCreationTime(results: TokenResult[]): TokenResult[] {
  return results.sort((a, b) => {
    const ta = a.createdAtMs ?? Infinity;
    const tb = b.createdAtMs ?? Infinity;
    if (ta !== tb) return ta - tb;
    return a.mint.localeCompare(b.mint);
  });
}

export function sortByVolumeUsd(results: TokenResult[]): TokenResult[] {
  return results.sort(
    (a, b) => (b.volumeUsd24h ?? 0) - (a.volumeUsd24h ?? 0)
  );
}

/** Social link search: market cap (or FDV), then 24h volume, then newer creation time. */
export function sortByMarketCapLeaderboard(
  results: TokenResult[]
): TokenResult[] {
  return results.sort((a, b) => {
    const mcA = a.marketCapUsd ?? a.fdvUsd ?? 0;
    const mcB = b.marketCapUsd ?? b.fdvUsd ?? 0;
    if (mcB !== mcA) return mcB - mcA;
    const vA = a.volumeUsd24h ?? 0;
    const vB = b.volumeUsd24h ?? 0;
    if (vB !== vA) return vB - vA;
    const tA = a.createdAtMs ?? 0;
    const tB = b.createdAtMs ?? 0;
    return tB - tA;
  });
}

/**
 * Stars (0–5): AGE-DATA QUALITY for one token — how trustworthy its creation
 * time is. NOT a name-match or OG score.
 *   5 — Helius DAS created_at (on the full path a completed signature scan
 *       found nothing older, corroborating it)
 *   4 — completed signature scan alone
 *   3 — DexScreener pair time only (pair creation lags token creation)
 *  ≤3 — createdAtIsLowerBound (truncated scan): true age is unknown-older
 *   1 — no time data yet (pendingAge / nothing found)
 */
export function ageDataQuality(token: TokenResult): number {
  if (token.pendingAge === true || token.createdAtMs == null) return 1;
  let stars = 1;
  if (token.timeSource === "helius") stars = 5;
  else if (token.timeSource === "signatures") stars = 4;
  else if (token.timeSource === "dexscreener") stars = 3;
  if (token.createdAtIsLowerBound === true) stars = Math.min(stars, 3);
  return stars;
}

/** Rank labels for social-link search (sorted by 24h volume). */
export function scoreVolumeRank(results: TokenResult[]): TokenResult[] {
  return results.map((token, index) => {
    const rank = index + 1;
    let confidenceLabel: string;
    if (index === 0) confidenceLabel = "Top 24h volume";
    else if (index < 3) confidenceLabel = "High volume";
    else confidenceLabel = "Lower volume";

    let rankLabel: string;
    if (index === 0) rankLabel = "Top";
    else if (index < 3) rankLabel = "High";
    else rankLabel = "—";

    return {
      ...token,
      rankingMode: "volume" as const,
      confidence: ageDataQuality(token),
      confidenceLabel,
      rank,
      rankLabel,
    };
  });
}

/** Rank labels for social-link search (MC → vol → age). */
export function scoreMarketCapRank(results: TokenResult[]): TokenResult[] {
  return results.map((token, index) => {
    const rank = index + 1;
    let confidenceLabel: string;
    if (index === 0) confidenceLabel = "Top market cap";
    else if (index < 3) confidenceLabel = "High market cap";
    else confidenceLabel = "Lower market cap";

    let rankLabel: string;
    if (index === 0) rankLabel = "Top";
    else if (index < 3) rankLabel = "High";
    else rankLabel = "—";

    return {
      ...token,
      rankingMode: "marketcap" as const,
      confidence: ageDataQuality(token),
      confidenceLabel,
      rank,
      rankLabel,
    };
  });
}

/**
 * OG scoring for creation-ranked results (assumes `results` sorted oldest-first).
 *
 * Two separate axes — do not conflate them:
 *  - LABEL (confidenceLabel/rankLabel) = OG-ness, rank-gated. Only rank 1 (the
 *    oldest) can carry an OG-flavored label; ranks 2+ are later mints by
 *    definition, so a perfect name match earns them no label (a copycat's whole
 *    job is matching the name). Rank 1: "OG" (exact-ish match + clear time gap
 *    to #2 + solid age data), "Likely OG" (weaker: small gap or fuzzy match),
 *    "Oldest found" (createdAtIsLowerBound or missing/pending time — the
 *    ordering itself is uncertain).
 *  - STARS (confidence) = per-token age-data quality via ageDataQuality().
 */
export function scoreConfidence(
  results: TokenResult[],
  query: string
): TokenResult[] {
  const nq = normalize(query);

  const withTimes = results.filter((r) => r.createdAtMs != null);
  const range =
    withTimes.length >= 2
      ? (withTimes[withTimes.length - 1].createdAtMs ?? 0) -
        (withTimes[0].createdAtMs ?? 0)
      : 0;

  const gapToSecond =
    withTimes.length >= 2
      ? (withTimes[1].createdAtMs ?? 0) - (withTimes[0].createdAtMs ?? 0)
      : 0;

  const significantGap = range > 0 && gapToSecond / range > 0.05;

  return results.map((token, index) => {
    const stars = ageDataQuality(token);

    const name = normalize(token.displayName);
    const symbol = normalize(token.displaySymbol);
    const exactName = name === nq;
    const exactSymbol = symbol === nq;

    let confidenceLabel = "";
    if (index === 0) {
      const uncertainAge =
        token.createdAtIsLowerBound === true ||
        token.pendingAge === true ||
        token.createdAtMs == null;
      // A lookalike-character name never earns an OG endorsement, even at
      // rank 1 — homoglyphSuspect is set server-side (enrich-results) and
      // rides through client re-scores untouched.
      if (uncertainAge || token.homoglyphSuspect === true)
        confidenceLabel = "Oldest found";
      else if ((exactName || exactSymbol) && significantGap && stars >= 4)
        confidenceLabel = "OG";
      else confidenceLabel = "Likely OG";
    }

    return {
      ...token,
      confidence: stars,
      confidenceLabel,
      rank: index + 1,
      rankLabel: confidenceLabel,
      // Informational only (small gray chip on ranks 2+) — no OG implication.
      exactMatch: exactName && exactSymbol ? (true as const) : undefined,
    };
  });
}

export function resolveDisplayName(
  dexName?: string | null,
  jupName?: string | null,
  heliusName?: string | null
): string {
  if (dexName && dexName !== "Unknown" && dexName !== "???") return dexName;
  if (jupName && jupName !== "Unknown" && jupName !== "???") return jupName;
  if (heliusName && heliusName !== "Unknown" && heliusName !== "???")
    return heliusName;
  return "Unknown";
}

export function resolveDisplaySymbol(
  dexSymbol?: string | null,
  jupSymbol?: string | null,
  heliusSymbol?: string | null
): string {
  if (dexSymbol && dexSymbol !== "???" && dexSymbol !== "Unknown")
    return dexSymbol;
  if (jupSymbol && jupSymbol !== "???" && jupSymbol !== "Unknown")
    return jupSymbol;
  if (heliusSymbol && heliusSymbol !== "???" && heliusSymbol !== "Unknown")
    return heliusSymbol;
  return "???";
}
