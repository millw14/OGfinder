import { MIN_QUERY, MAX_QUERY } from "./types";
import { stripInvisibles } from "./normalize";

/**
 * Build a Dex/Jupiter search string from Helius metadata (max MAX_QUERY chars).
 * Invisible characters are stripped so a disguised name (e.g. trailing word
 * joiner) still matches its plain-named duplicates upstream. Deliberately NOT
 * skeleton-folded — the homoglyph flag relies on comparing against the raw
 * lookalike form.
 */
export function deriveSearchTermFromMintMetadata(
  heliusName: string | null,
  heliusSymbol: string | null
): string {
  const name = stripInvisibles(heliusName ?? "").trim();
  const symbol = stripInvisibles(heliusSymbol ?? "").trim();
  if (name.length >= MIN_QUERY) return name.slice(0, MAX_QUERY);
  if (symbol.length >= MIN_QUERY) return symbol.slice(0, MAX_QUERY);
  if (name.length > 0) return name.slice(0, MAX_QUERY);
  if (symbol.length > 0) return symbol.slice(0, MAX_QUERY);
  return "";
}
