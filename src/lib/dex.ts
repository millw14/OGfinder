import { RawToken, DEX_LIMIT, DEX_TIMEOUT } from "./types";
import { fetchWithTimeout } from "./fetch";
import { normalize, dexPairCreatedMs } from "./normalize";
import { getDexCache, setDexCache } from "./cache";

const DEX_URL = "https://api.dexscreener.com/latest/dex/search";

interface DexPair {
  chainId: string;
  dexId: string;
  pairCreatedAt?: number;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
}

interface DexResponse {
  pairs: DexPair[] | null;
}

export async function searchDex(query: string): Promise<RawToken[]> {
  const normalizedQuery = normalize(query);
  const cached = getDexCache<RawToken[]>(normalizedQuery);
  if (cached) return cached;

  try {
    const data = (await fetchWithTimeout(
      `${DEX_URL}?q=${encodeURIComponent(query)}`,
      DEX_TIMEOUT
    )) as DexResponse;

    if (!data?.pairs) return [];

    // Re-filter DexScreener results: their search is fuzzy and matches
    // individual words, so "ara grok 3" would match "HARAMBE" via "ara".
    // We require the normalized name or symbol to contain the full query.
    const solanaPairs = data.pairs.filter((p) => {
      if (p.chainId !== "solana") return false;
      const name = normalize(p.baseToken.name);
      const symbol = normalize(p.baseToken.symbol);
      return name.includes(normalizedQuery) || symbol.includes(normalizedQuery);
    });

    // Group by baseToken.address and keep the OLDEST pairCreatedAt per token
    const tokenMap = new Map<
      string,
      { pair: DexPair; oldestPairTime: number | undefined }
    >();

    for (const pair of solanaPairs) {
      const mint = pair.baseToken.address;
      const pairMs = dexPairCreatedMs(pair.pairCreatedAt);
      const existing = tokenMap.get(mint);

      if (!existing) {
        tokenMap.set(mint, { pair, oldestPairTime: pairMs });
      } else if (
        pairMs != null &&
        (!existing.oldestPairTime || pairMs < existing.oldestPairTime)
      ) {
        existing.oldestPairTime = pairMs;
      }
    }

    const entries = Array.from(tokenMap.entries());
    entries.sort((a, b) => {
      const ta = a[1].oldestPairTime ?? Number.POSITIVE_INFINITY;
      const tb = b[1].oldestPairTime ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a[0].localeCompare(b[0]);
    });

    const tokens: RawToken[] = [];
    for (const [mint, { pair, oldestPairTime }] of entries) {
      tokens.push({
        mint,
        dexName: pair.baseToken.name,
        dexSymbol: pair.baseToken.symbol,
        dexId: pair.dexId,
        pairCreatedAt: oldestPairTime,
      });
      if (tokens.length >= DEX_LIMIT) break;
    }

    setDexCache(normalizedQuery, tokens);
    return tokens;
  } catch {
    return [];
  }
}
