import { TokenResult } from "./types";
import { normalize } from "./normalize";

export function sortByCreationTime(results: TokenResult[]): TokenResult[] {
  return results.sort(
    (a, b) => (a.createdAtMs ?? Infinity) - (b.createdAtMs ?? Infinity)
  );
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
      confidence: Math.max(1, 5 - Math.min(index, 4)),
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
      confidence: Math.max(1, 5 - Math.min(index, 4)),
      confidenceLabel,
      rank,
      rankLabel,
    };
  });
}

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
    let score = 0;

    const name = normalize(token.displayName);
    const symbol = normalize(token.displaySymbol);

    if (name === nq) score += 2;
    if (symbol === nq) score += 1;
    if (score < 3 && (name.includes(nq) || symbol.includes(nq))) score += 1;
    if (index === 0 && significantGap) score += 1;

    score = Math.min(score, 5);

    let confidenceLabel: string;
    if (score >= 5) confidenceLabel = "OG";
    else if (score >= 3) confidenceLabel = "Likely OG";
    else confidenceLabel = "Low confidence";

    let rankLabel: string;
    if (index === 0) rankLabel = "OG";
    else if (index <= 2) rankLabel = "Older";
    else rankLabel = "Newer";

    return {
      ...token,
      confidence: score,
      confidenceLabel,
      rank: index + 1,
      rankLabel,
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
