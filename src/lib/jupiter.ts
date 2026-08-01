import { RawToken, JUP_LIMIT, CACHE_JUP } from "./types";
import { fetchWithTimeout } from "./fetch";
import { normalize } from "./normalize";

// Jupiter Token API v2 (free "lite" tier). The old full-list host
// (tokens.jup.ag) is dead; this endpoint does relevance-ordered search by
// name/symbol/mint. lite-api is rate-limited, so results are cached per
// query and no full-list downloads happen.
const JUP_SEARCH_URL = "https://lite-api.jup.ag/tokens/v2/search";
/** The API caps search responses at 100 tokens per request. */
const JUP_API_LIMIT = 100;
const JUP_TIMEOUT = 8000;

interface JupiterToken {
  id: string; // mint address
  name: string;
  symbol: string;
}

/** Per-query response cache — lite-api is rate-limited, avoid repeat hits. */
const jupQueryCache = new Map<string, { at: number; tokens: JupiterToken[] }>();
const JUP_CACHE_MAX_KEYS = 500;

function pruneQueryCache(): void {
  const now = Date.now();
  jupQueryCache.forEach((entry, key) => {
    if (now - entry.at >= CACHE_JUP * 1000) jupQueryCache.delete(key);
  });
  // Still over the cap: drop oldest-inserted entries.
  while (jupQueryCache.size >= JUP_CACHE_MAX_KEYS) {
    const oldest = jupQueryCache.keys().next().value;
    if (oldest === undefined) break;
    jupQueryCache.delete(oldest);
  }
}

/** One search call (term can be a name, symbol, or mint address). */
async function jupSearch(term: string): Promise<JupiterToken[]> {
  const cached = jupQueryCache.get(term);
  if (cached && Date.now() - cached.at < CACHE_JUP * 1000) {
    return cached.tokens;
  }
  try {
    const data = await fetchWithTimeout(
      `${JUP_SEARCH_URL}?query=${encodeURIComponent(term)}&limit=${JUP_API_LIMIT}`,
      JUP_TIMEOUT
    );
    if (!Array.isArray(data)) return cached?.tokens ?? [];
    const tokens: JupiterToken[] = [];
    for (const t of data as Partial<JupiterToken>[]) {
      if (
        typeof t?.id === "string" &&
        typeof t.name === "string" &&
        typeof t.symbol === "string"
      ) {
        tokens.push({ id: t.id, name: t.name, symbol: t.symbol });
      }
    }
    if (jupQueryCache.size >= JUP_CACHE_MAX_KEYS) pruneQueryCache();
    jupQueryCache.set(term, { at: Date.now(), tokens });
    return tokens;
  } catch {
    // Timeout / rate limit / non-2xx: serve stale if we have it.
    return cached?.tokens ?? [];
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
  return [tier, displayLen, token.id];
}

export async function searchJupiter(query: string): Promise<RawToken[]> {
  const normalizedQuery = normalize(query);
  const tokens = await jupSearch(query);

  // The API fuzzy-matches; keep the old contract of the normalized name or
  // symbol containing the full query (mirrors the DexScreener re-filter).
  const matches = tokens.filter((token) => {
    const name = normalize(token.name);
    const symbol = normalize(token.symbol);
    return name.includes(normalizedQuery) || symbol.includes(normalizedQuery);
  });

  matches.sort((a, b) => {
    const ka = jupiterRelevanceKey(a, normalizedQuery);
    const kb = jupiterRelevanceKey(b, normalizedQuery);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });

  return matches.slice(0, JUP_LIMIT).map((token) => ({
    mint: token.id,
    jupName: token.name,
    jupSymbol: token.symbol,
  }));
}

/** Search by mint address — used when DAS has no metadata for a mint. */
export async function getJupiterTokenByMint(
  mint: string
): Promise<{ name: string; symbol: string } | null> {
  const tokens = await jupSearch(mint);
  const t = tokens.find((token) => token.id === mint);
  if (!t) return null;
  return { name: t.name, symbol: t.symbol };
}
