import { RawToken, MAX_HELIUS } from "./types";
import { searchDex } from "./dex";
import { searchJupiter } from "./jupiter";

export async function searchTokens(query: string): Promise<RawToken[]> {
  const [dexResults, jupResults] = await Promise.all([
    searchDex(query),
    searchJupiter(query),
  ]);

  const merged = new Map<string, RawToken>();

  for (const token of dexResults) {
    merged.set(token.mint, token);
  }

  for (const token of jupResults) {
    const existing = merged.get(token.mint);
    if (existing) {
      existing.jupName = token.jupName;
      existing.jupSymbol = token.jupSymbol;
    } else {
      merged.set(token.mint, token);
    }
  }

  const deduped = Array.from(merged.values());
  return deduped.slice(0, MAX_HELIUS);
}
