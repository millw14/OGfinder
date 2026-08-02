import { RawToken, MAX_HELIUS, MIN_QUERY } from "./types";
import { searchDex } from "./dex";
import { searchJupiter } from "./jupiter";
import { normalize, skeleton } from "./normalize";

export async function searchTokens(query: string): Promise<RawToken[]> {
  // Lookalike queries (Cyrillic "Воnk", zero-width tricks) match nothing
  // upstream as-is — also query with the skeleton-folded term so the Latin
  // originals surface. Primary results win on conflicts; folded fill gaps.
  const folded = skeleton(query);
  const useFolded = folded.length >= MIN_QUERY && folded !== normalize(query);

  const [dexResults, jupResults, dexFolded, jupFolded] = await Promise.all([
    searchDex(query),
    searchJupiter(query),
    useFolded ? searchDex(folded) : Promise.resolve([] as RawToken[]),
    useFolded ? searchJupiter(folded) : Promise.resolve([] as RawToken[]),
  ]);

  const merged = new Map<string, RawToken>();

  for (const token of [...dexResults, ...dexFolded]) {
    if (!merged.has(token.mint)) merged.set(token.mint, token);
  }

  for (const token of [...jupResults, ...jupFolded]) {
    const existing = merged.get(token.mint);
    if (existing) {
      if (existing.jupName === undefined) existing.jupName = token.jupName;
      if (existing.jupSymbol === undefined) {
        existing.jupSymbol = token.jupSymbol;
      }
    } else {
      merged.set(token.mint, token);
    }
  }

  const deduped = Array.from(merged.values());
  // Caps Helius enrich work (getAssetBatch + getCreationSlot per mint); see MAX_HELIUS.
  return deduped.slice(0, MAX_HELIUS);
}
