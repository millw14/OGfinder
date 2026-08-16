import { normalize, skeleton } from "./normalize";

/**
 * How strongly does a token's identity relate to the queried name?
 *
 * The original rule was a raw substring test, and it matched INSIDE words: a
 * scan of $KARAT ("Karat Life Companion") pulled in "Karate Cat" ($KRCT)
 * because "karate cat".includes("karat"), and that unrelated 2024 token —
 * being older — then took the OG crown. Same class of bug as "trump" matching
 * "trumpet".
 *
 * Dropping those tokens fixed the crown but threw away results people wanted
 * to see: "bonk" stopped finding "BONKMONEY", and the cohort halved. So the
 * boolean became a TIER, and the two questions are now answered separately:
 *
 *   IS IT IN THE COHORT?      any tier — including "partial".
 *   CAN IT TAKE THE CROWN?    isCrownEligible(), i.e. "exact" or "word" only.
 *
 * The tiers:
 *   exact   — the normalized NAME or SYMBOL *is* the query.
 *   word    — the query appears in the name as a run of WHOLE words. "karat"
 *             hits "Karat Life Companion" and misses "Karate Cat".
 *   partial — the query is a bare substring of the name or symbol and nothing
 *             better ("bonk" in "BONKMONEY", "karat" in "Karate Cat"). Shown,
 *             never crowned: a name that merely CONTAINS the word is not
 *             competing for it.
 *   null    — no relationship at all.
 *
 * A ticker only reaches "exact" by matching IN FULL — a ticker is one atomic
 * token, so "KRCT" can never satisfy a search for "KARAT" — and that is also
 * what keeps a search for "wif" finding dogwifhat, whose symbol IS $WIF.
 *
 * Every form is tried again under skeleton folding, and the STRONGEST tier
 * across both wins, so Cyrillic/zero-width copycats are still admitted (and
 * flagged downstream) instead of vanishing.
 */

export type MatchTier = "exact" | "word" | "partial" | null;

/** Strength order, so "strongest across both forms" is a plain comparison. */
const TIER_STRENGTH: Record<Exclude<MatchTier, null>, number> = {
  exact: 3,
  word: 2,
  partial: 1,
};

/**
 * Can a token at this tier hold the OG crown for the query?
 *
 * THE ONE DEFINITION of that rule — sorting, scoring, the registry and the bot
 * all read it from here rather than re-deriving it, so "related names never
 * take the crown" cannot drift apart between surfaces.
 */
export function isCrownEligible(tier: MatchTier): boolean {
  return tier === "exact" || tier === "word";
}

/** Whole-word containment over space-separated normalized text. */
export function containsWholeWords(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  // normalize() has already collapsed separators to single spaces, so padding
  // both sides turns "contains" into "contains as whole word(s)".
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Best tier for ONE normalization form (all three inputs already folded). */
function tierForForm(name: string, symbol: string, query: string): MatchTier {
  if (!query) return null;
  if ((name && name === query) || (symbol && symbol === query)) return "exact";
  if (containsWholeWords(name, query)) return "word";
  // Bare substring — the old, over-eager rule. Kept as the WEAKEST tier so a
  // derivative name is visible without being a contender. Symbols are included
  // here too: "BONKMONEY" contains "bonk", but only in the way a longer word
  // contains a shorter one.
  if (name.includes(query) || symbol.includes(query)) return "partial";
  return null;
}

/**
 * How this token relates to `query`. Pure.
 * Feed it RAW name/symbol/query — it normalizes and skeleton-folds internally,
 * and returns the strongest tier either form produces.
 */
export function tokenMatchTier(
  rawName: string | null | undefined,
  rawSymbol: string | null | undefined,
  query: string
): MatchTier {
  const name = rawName ?? "";
  const symbol = rawSymbol ?? "";

  const plain = tierForForm(normalize(name), normalize(symbol), normalize(query));
  if (plain === "exact") return plain;

  // Always retried folded, even when the query itself is clean: the LOOKALIKE
  // may be on the token's side ("Воnk" with a Cyrillic В).
  const folded = tierForForm(skeleton(name), skeleton(symbol), skeleton(query));

  if (plain == null) return folded;
  if (folded == null) return plain;
  return TIER_STRENGTH[folded] > TIER_STRENGTH[plain] ? folded : plain;
}

/**
 * True when this token belongs in the cohort for `query` at all — ANY tier.
 * Cohort admission only; it says nothing about who may wear the crown, which
 * is isCrownEligible(tokenMatchTier(...)).
 */
export function tokenMatchesQuery(
  rawName: string | null | undefined,
  rawSymbol: string | null | undefined,
  query: string
): boolean {
  return tokenMatchTier(rawName, rawSymbol, query) !== null;
}
