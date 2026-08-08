import { MIN_QUERY, MAX_QUERY } from "./types";
import { normalize, stripInvisibles } from "./normalize";

function clean(raw: string | null): string {
  return stripInvisibles(raw ?? "").trim();
}

/**
 * Search terms for a mint scan: the token's NAME and its TICKER, both.
 *
 * A copycat commonly rides someone else's ticker while riffing on the name —
 * "Pepe Cosplay" trading as $CoPepe next to the older $COPEPE. Searching only
 * the first term that fits (the old behaviour) hides that entire cohort, so
 * the scan finds nothing but itself and crowns a newer token as the OG.
 * Searching both terms and merging is what makes the contested-identity case
 * visible.
 *
 * Ordered primary-first — the primary is the term used for scoring/display,
 * and keeps the historical precedence (a usable name wins, else the symbol).
 * Deduped by normalized form, so name === symbol still costs one search.
 * Invisible characters are stripped (a disguised name still matches its plain
 * duplicates upstream); deliberately NOT skeleton-folded, because the
 * homoglyph flag compares against the raw lookalike form.
 */
export function deriveSearchTermsFromMintMetadata(
  heliusName: string | null,
  heliusSymbol: string | null
): string[] {
  const name = clean(heliusName);
  const symbol = clean(heliusSymbol);

  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (raw.length < MIN_QUERY) return;
    const term = raw.slice(0, MAX_QUERY);
    const key = normalize(term);
    if (!key || seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };

  if (name.length >= MIN_QUERY) {
    add(name);
    add(symbol);
  } else {
    add(symbol);
    add(name);
  }

  if (terms.length === 0) {
    // Nothing long enough to search: hand back whatever exists so the caller's
    // own MIN_QUERY guard still produces the established error message.
    const fallback = name || symbol;
    if (fallback) terms.push(fallback.slice(0, MAX_QUERY));
  }
  return terms;
}

/** Primary search term only — for callers that need a single string. */
export function deriveSearchTermFromMintMetadata(
  heliusName: string | null,
  heliusSymbol: string | null
): string {
  return deriveSearchTermsFromMintMetadata(heliusName, heliusSymbol)[0] ?? "";
}
