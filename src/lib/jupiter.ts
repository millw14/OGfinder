import { RawToken, JUP_LIMIT, CACHE_JUP } from "./types";
import { fetchWithTimeout } from "./fetch";
import { normalize } from "./normalize";

// Use the full token list (no tag filter) for broader coverage of old/dead tokens
const JUP_URL = "https://tokens.jup.ag/tokens";

interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
}

let jupiterTokens: JupiterToken[] | null = null;
let jupiterLoadedAt = 0;
let jupiterByMint: Map<string, JupiterToken> | null = null;

async function getJupiterList(): Promise<JupiterToken[]> {
  if (jupiterTokens && Date.now() - jupiterLoadedAt < CACHE_JUP * 1000) {
    return jupiterTokens;
  }
  try {
    const data = (await fetchWithTimeout(JUP_URL, 15000)) as JupiterToken[];
    if (Array.isArray(data)) {
      jupiterTokens = data;
      jupiterByMint = null;
      jupiterLoadedAt = Date.now();
      return jupiterTokens;
    }
    return jupiterTokens ?? [];
  } catch {
    return jupiterTokens ?? [];
  }
}

export async function searchJupiter(query: string): Promise<RawToken[]> {
  const normalizedQuery = normalize(query);
  const list = await getJupiterList();

  const results: RawToken[] = [];

  for (const token of list) {
    const name = normalize(token.name);
    const symbol = normalize(token.symbol);

    if (name.includes(normalizedQuery) || symbol.includes(normalizedQuery)) {
      results.push({
        mint: token.address,
        jupName: token.name,
        jupSymbol: token.symbol,
      });
      if (results.length >= JUP_LIMIT) break;
    }
  }

  return results;
}

/** O(1) lookup after list load — used when DAS has no metadata for a mint. */
export async function getJupiterTokenByMint(
  mint: string
): Promise<{ name: string; symbol: string } | null> {
  const list = await getJupiterList();
  if (list.length === 0) return null;
  if (!jupiterByMint) {
    jupiterByMint = new Map(list.map((t) => [t.address, t]));
  }
  const t = jupiterByMint.get(mint);
  if (!t) return null;
  return { name: t.name, symbol: t.symbol };
}
