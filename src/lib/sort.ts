import { TokenResult } from "./types";
import { normalize } from "./normalize";

/**
 * Rank-1 label when a blocking safety flag fired. States the fact we verified
 * (it is the oldest) and withholds the endorsement — the specific mechanism is
 * named by the token's safetyFlags, not by this label.
 */
export const UNSAFE_RANK1_LABEL = "Oldest — unsafe";

/**
 * Rank-1 label when the ORDER ITSELF is unproven: this is the oldest token we
 * could date, but at least one token ranked below it carries a lower-bound age
 * that could turn out to predate it. The rank is our best answer, not a fact,
 * so the endorsement is withheld until the ambiguity is resolved.
 */
export const UNPROVEN_RANK1_LABEL = "Oldest known — unverified";

/** True when this rank-1 label is an OG endorsement (crown-worthy). */
export function isOgEndorsement(confidenceLabel: string): boolean {
  return confidenceLabel === "OG" || confidenceLabel === "Likely OG";
}

/**
 * Ascending by creation time, with the REAL COHORT FIRST.
 *
 * Primary key: relatedOnly (false before true). A derivative name — "BONKMONEY"
 * in a "bonk" search — is shown because it is interesting, but it is not
 * competing for the name, so it sorts below every token that is, however old it
 * is. That is what makes the crown safe by construction: rank 1 is always a
 * real contender, so no derivative can take it even when it predates the field.
 *
 * Secondary key: creation time, with its bounds-aware semantics unchanged
 * WITHIN each group. A token whose time is a LOWER BOUND still sorts by that
 * bound, which is correct in one direction only: a bound older than the
 * leader's exact date proves that token is older (true ≤ bound < leader). A
 * bound NEWER than the leader proves nothing — see ageOrderConfidence.
 *
 * Ranks stay a single 1..N sequence over the whole list — the related group is
 * the tail of the same list, not a second numbering.
 */
export function sortByCreationTime(results: TokenResult[]): TokenResult[] {
  return results.sort((a, b) => {
    const ra = a.relatedOnly === true ? 1 : 0;
    const rb = b.relatedOnly === true ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ta = a.createdAtMs ?? Infinity;
    const tb = b.createdAtMs ?? Infinity;
    if (ta !== tb) return ta - tb;
    return a.mint.localeCompare(b.mint);
  });
}

/**
 * How close an unresolved bound must sit to the leader before it is treated as
 * a live threat to the #1 answer.
 *
 * A truncated token has ≥ MAX_SIG_PAGES × 1000 transactions all NEWER than its
 * bound. For it to actually predate the leader it must therefore have sat
 * essentially dormant for the whole gap, then suddenly produced thousands of
 * transactions. Inside a year that is unremarkable — the reported regression
 * was a 3-month gap and the token really was older. At 2-4 years it is a
 * different claim entirely: every unresolved token in the "bonk" cohort sits
 * 29-44 months newer than BONK.
 *
 * So the gap decides whether the crown is BLOCKED; every unresolved token is
 * still counted and disclosed either way. Widen this to be stricter.
 */
export const MATERIAL_AGE_GAP_MS = 365 * 24 * 60 * 60 * 1000;

/** Whether the #1 answer is provable from the data we currently hold. */
export interface AgeOrderConfidence {
  /** True when nothing can CREDIBLY overturn the #1 answer. */
  proven: boolean;
  /**
   * Mints whose unresolved age is close enough to the leader to block the
   * endorsement, in rank order (the leader first when it is one of them).
   */
  blockingMints: string[];
  blockingCount: number;
  /**
   * EVERY token with an unresolved age, including the ones too far from the
   * leader to be credible threats. Always disclosed to the user — the crown is
   * gated on blockingCount, but the caveat reports the honest total.
   */
  unresolvedMints: string[];
  unresolvedCount: number;
}

/**
 * Is the #1 answer PROVEN?
 *
 * createdAtIsLowerBound means "true creation is AT OR BEFORE this timestamp, by
 * an unknown amount" — there is no floor. So for a truncated token X at bound
 * t_X against the leader L at t_L:
 *   t_X < t_L → X already sorts above L and IS older; the order is safe.
 *   t_X > t_L → UNKNOWABLE. X may predate L by years (the reported regression:
 *               a 2.5-year-old token whose 5-page walk reported an 18-month-old
 *               date and sorted BELOW a 1-year-old token).
 * Post-sort, every truncated token that is not the leader is in the second
 * case — so each is a POTENTIAL threat. Whether it is a CREDIBLE one is
 * decided by MATERIAL_AGE_GAP_MS (see there): a bound just months newer than
 * the leader is an ordinary overlap, a bound years newer would require the
 * token to have been dormant that entire time.
 *
 * The leader also has to know its own age: a leader that is itself a lower
 * bound, still pending, or undated cannot be asserted as the oldest either —
 * that always blocks, regardless of gap.
 *
 * relatedOnly tokens are skipped entirely: a derivative name cannot take the
 * crown at any age, so its unresolved age is not evidence against the #1 — it
 * neither blocks nor counts as unresolved.
 *
 * Pure — no I/O, no clock — so the client re-score reaches the same verdict.
 *
 * @param rankedTokens sorted oldest-first (sortByCreationTime output)
 */
export function ageOrderConfidence(
  rankedTokens: TokenResult[]
): AgeOrderConfidence {
  const blockingMints: string[] = [];
  const unresolvedMints: string[] = [];
  const empty = { blockingMints, blockingCount: 0, unresolvedMints, unresolvedCount: 0 };
  // No tokens = no #1 answer to get wrong. Vacuously proven.
  if (!Array.isArray(rankedTokens) || rankedTokens.length === 0) {
    return { proven: true, ...empty };
  }

  const leader = rankedTokens[0];
  const leaderTime = leader.createdAtMs;
  const leaderUnresolved =
    leader.createdAtIsLowerBound === true ||
    leader.pendingAge === true ||
    leaderTime == null;
  // A leader that cannot date itself always blocks — no gap reasoning applies.
  if (leaderUnresolved) {
    blockingMints.push(leader.mint);
    unresolvedMints.push(leader.mint);
  }

  for (let i = 1; i < rankedTokens.length; i++) {
    // Followers count ONLY via a lower bound: an exact date below the leader
    // is settled, and a missing date is "unknown", which the leader's own
    // check already covers for the only rank that makes a claim.
    const t = rankedTokens[i];
    // A derivative name is not competing for the name, so however old it turns
    // out to be it cannot overturn the OG — its unresolved age is not a threat
    // to the #1 answer and is counted in neither list.
    if (t.relatedOnly === true) continue;
    if (t.createdAtIsLowerBound !== true) continue;
    unresolvedMints.push(t.mint);

    const bound = t.createdAtMs;
    // Unknown bound, or a leader with no date to measure against: cannot rule
    // the threat out, so it blocks.
    const credible =
      bound == null ||
      leaderTime == null ||
      bound - leaderTime <= MATERIAL_AGE_GAP_MS;
    if (credible) blockingMints.push(t.mint);
  }

  return {
    proven: blockingMints.length === 0,
    blockingMints,
    blockingCount: blockingMints.length,
    unresolvedMints,
    unresolvedCount: unresolvedMints.length,
  };
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
 *    job is matching the name).
 *  - STARS (confidence) = per-token age-data quality via ageDataQuality().
 *
 * RANK-1 LABEL PRECEDENCE (first match wins the single label slot):
 *   1. own age uncertain (lower bound / pending / undated) OR homoglyph OR a
 *      derivative name (relatedOnly — not competing for the name at all)
 *        → "Oldest found". Highest because every label below states "oldest"
 *          as a fact about THIS token, and here that fact is not established.
 *   2. blocking safety flag (safetyLevel "danger")
 *        → UNSAFE_RANK1_LABEL. The age claim stands; the endorsement does not.
 *   3. order unproven (a lower-bound token ranks BELOW this one, so something
 *      down the list may predate it — see ageOrderConfidence)
 *        → UNPROVEN_RANK1_LABEL.
 *   4. otherwise → "OG" (exact-ish match + clear gap to #2 + solid age data)
 *      or "Likely OG".
 * Tiers 1-3 are all non-endorsements (isOgEndorsement === false); only the
 * wording differs, and the most fundamental caveat gets to do the talking.
 *
 * THE CROWN IS AN ENDORSEMENT AND MUST BE EARNED. Rank stays factual — the
 * oldest token we found is still #1 — but a token that can freeze, seize, or
 * block your sells, or whose lead over the field is not provable, never gets
 * the word "OG" attached to it here.
 *
 * Pure (no I/O), so the client re-score in Results.tsx produces the identical
 * verdict from the identical list.
 */
export function scoreConfidence(
  results: TokenResult[],
  query: string
): TokenResult[] {
  const nq = normalize(query);

  // The server scores the FULL cohort before it is sliced to MAX_RESULTS, so a
  // flag already on the wire saw more tokens than a client re-score can: it is
  // sticky, never re-derived away. (Still pure — it only reads its input.)
  const order = ageOrderConfidence(results);
  const orderUnproven =
    !order.proven || results[0]?.ageOrderUnproven === true;

  // Dated tokens that are actually CONTESTING the name, in age order. Related
  // names are excluded on both counts: they sit at the tail of the list rather
  // than in time order (sortByCreationTime), which would make `range` garbage,
  // and the lead that earns the crown is the lead over the next real
  // contender — a derivative name is not one, so it cannot dilute it.
  const withTimes = results.filter(
    (r) => r.createdAtMs != null && r.relatedOnly !== true
  );
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
      //
      // Nor does a DERIVATIVE name. sortByCreationTime puts every relatedOnly
      // token below the real cohort, so this is unreachable while a single
      // eligible token exists — it fires only when the whole list is
      // derivative, and then it states the plain fact ("this is the oldest we
      // found") without claiming the name for it. Kept as an assertion in the
      // scorer, the same way the danger and unproven branches are: the crown
      // is refused HERE, not merely made unlikely by the sort.
      if (
        uncertainAge ||
        token.homoglyphSuspect === true ||
        token.relatedOnly === true
      )
        confidenceLabel = "Oldest found";
      // A blocking safety flag costs the endorsement, never the rank: this
      // token IS the oldest, and we say so — we just refuse to vouch for it.
      // (Uncertain age keeps its precedence above; either way, no crown.)
      else if (token.safetyLevel === "danger")
        confidenceLabel = UNSAFE_RANK1_LABEL;
      // This token's own age is exact, but something ranked below it is still
      // a lower bound and could predate it. We report the best-known order and
      // refuse to call it proven.
      else if (orderUnproven) confidenceLabel = UNPROVEN_RANK1_LABEL;
      else if ((exactName || exactSymbol) && significantGap && stars >= 4)
        confidenceLabel = "OG";
      else confidenceLabel = "Likely OG";
    }

    const scored: TokenResult = {
      ...token,
      confidence: stars,
      confidenceLabel,
      rank: index + 1,
      rankLabel: confidenceLabel,
      // Informational only (small gray chip on ranks 2+) — no OG implication.
      exactMatch: exactName && exactSymbol ? (true as const) : undefined,
    };

    // Rank 1 carries the order verdict on the wire so the client, the bot and
    // the share card render the same state without recomputing it. Cleared on
    // every other rank, so a re-score can never leave it stale.
    if (index === 0 && orderUnproven) scored.ageOrderUnproven = true;
    else delete scored.ageOrderUnproven;

    return scored;
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
