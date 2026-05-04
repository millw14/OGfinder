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

/** Lower rank = better. Exact name > exact symbol > prefix > substring; shorter label wins ties. */
function jupiterRelevanceKey(
  token: JupiterToken,
  q: string
): [number, number, string] {
  const name = normalize(token.name);
  const symbol = normalize(token.symbol);
  let tier = 3;
  if (name === q) tier = 0;
  else if (symbol === q) tier = 1;
  else if (name.startsWith(q) || symbol.startsWith(q)) tier = 2;

  const displayLen = token.name.length + token.symbol.length;
  return [tier, displayLen, token.address];
}

export async function searchJupiter(query: string): Promise<RawToken[]> {
  const normalizedQuery = normalize(query);
  const list = await getJupiterList();

  const matches: JupiterToken[] = [];
  for (const token of list) {
    const name = normalize(token.name);
    const symbol = normalize(token.symbol);
    if (name.includes(normalizedQuery) || symbol.includes(normalizedQuery)) {
      matches.push(token);
    }
  }

  matches.sort((a, b) => {
    const ka = jupiterRelevanceKey(a, normalizedQuery);
    const kb = jupiterRelevanceKey(b, normalizedQuery);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });

  return matches.slice(0, JUP_LIMIT).map((token) => ({
    mint: token.address,
    jupName: token.name,
    jupSymbol: token.symbol,
  }));
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
