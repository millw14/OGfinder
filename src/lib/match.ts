import { normalize, skeleton } from "./normalize";

/**
 * Does a token's identity actually contest the queried name?
 *
 * The old rule was a raw substring test, and it matched INSIDE words: a scan of
 * $KARAT ("Karat Life Companion") pulled in "Karate Cat" ($KRCT) because
 * "karate cat".includes("karat"), and that unrelated 2024 token — being older —
 * then took the OG crown. Same class of bug as "trump" matching "trumpet".
 *
 * So:
 *   NAMES match on WORD BOUNDARIES. "karat" hits "Karat Life Companion" and
 *   misses "Karate Cat"; a multi-word query must appear as a run of whole words.
 *   TICKERS match IN FULL. A ticker is one atomic token — "KRCT" can never
 *   satisfy a search for "KARAT" — and this is also what keeps a search for
 *   "wif" finding dogwifhat, whose symbol IS $WIF.
 *
 * Both forms are tried again under skeleton folding so Cyrillic/zero-width
 * copycats are still admitted (and flagged downstream) instead of vanishing.
 */

/** Whole-word containment over space-separated normalized text. */
export function containsWholeWords(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  // normalize() has already collapsed separators to single spaces, so padding
  // both sides turns "contains" into "contains as whole word(s)".
  return ` ${haystack} `.includes(` ${needle} `);
}

/** One normalization form: exact ticker, or the query as whole words of the name. */
function matchesForm(name: string, symbol: string, query: string): boolean {
  if (!query) return false;
  if (symbol && symbol === query) return true;
  return containsWholeWords(name, query);
}

/**
 * True when this token belongs in the cohort for `query`. Pure.
 * Feed it RAW name/symbol/query — it normalizes and skeleton-folds internally.
 */
export function tokenMatchesQuery(
  rawName: string | null | undefined,
  rawSymbol: string | null | undefined,
  query: string
): boolean {
  const name = rawName ?? "";
  const symbol = rawSymbol ?? "";
  if (matchesForm(normalize(name), normalize(symbol), normalize(query))) {
    return true;
  }
  // Always retried folded, even when the query itself is clean: the LOOKALIKE
  // may be on the token's side ("Воnk" with a Cyrillic В).
  return matchesForm(skeleton(name), skeleton(symbol), skeleton(query));
}
