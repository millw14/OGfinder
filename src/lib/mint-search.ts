import { MIN_QUERY, MAX_QUERY } from "./types";

/**
 * Build a Dex/Jupiter search string from Helius metadata (max MAX_QUERY chars).
 */
export function deriveSearchTermFromMintMetadata(
  heliusName: string | null,
  heliusSymbol: string | null
): string {
  const name = (heliusName ?? "").trim();
  const symbol = (heliusSymbol ?? "").trim();
  if (name.length >= MIN_QUERY) return name.slice(0, MAX_QUERY);
  if (symbol.length >= MIN_QUERY) return symbol.slice(0, MAX_QUERY);
  if (name.length > 0) return name.slice(0, MAX_QUERY);
  if (symbol.length > 0) return symbol.slice(0, MAX_QUERY);
  return "";
}
