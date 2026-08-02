import { RawToken, DEX_LIMIT, DEX_TIMEOUT } from "./types";
import { fetchWithTimeout } from "./fetch";
import { normalize, skeleton, dexPairCreatedMs } from "./normalize";
import { getDexCache, setDexCache } from "./cache";

const DEX_URL = "https://api.dexscreener.com/latest/dex/search";

interface DexPair {
  chainId: string;
  dexId: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
  info?: { imageUrl?: string };
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
    // Skeleton matching also admits lookalike copycats (Cyrillic "Воnk",
    // zero-width-joined "Bonk") so they get ranked and flagged instead of
    // being invisibly dropped.
    const skeletonQuery = skeleton(query);
    const solanaPairs = data.pairs.filter((p) => {
      if (p.chainId !== "solana") return false;
      const name = normalize(p.baseToken.name);
      const symbol = normalize(p.baseToken.symbol);
      if (name.includes(normalizedQuery) || symbol.includes(normalizedQuery)) {
        return true;
      }
      return (
        skeletonQuery.length > 0 &&
        (skeleton(p.baseToken.name).includes(skeletonQuery) ||
          skeleton(p.baseToken.symbol).includes(skeletonQuery))
      );
    });

    // Group by baseToken.address and keep the OLDEST pairCreatedAt per token,
    // plus the HIGHEST-LIQUIDITY pair for market data (price/liq/24h/logo).
    const tokenMap = new Map<
      string,
      { pair: DexPair; oldestPairTime: number | undefined; marketPair: DexPair }
    >();

    for (const pair of solanaPairs) {
      const mint = pair.baseToken.address;
      const pairMs = dexPairCreatedMs(pair.pairCreatedAt);
      const existing = tokenMap.get(mint);

      if (!existing) {
        tokenMap.set(mint, { pair, oldestPairTime: pairMs, marketPair: pair });
        continue;
      }
      if (
        pairMs != null &&
        (!existing.oldestPairTime || pairMs < existing.oldestPairTime)
      ) {
        // Keep the OLDEST pair's identity too (dexId/name/symbol), so the
        // launch venue reflects where the token actually launched.
        existing.oldestPairTime = pairMs;
        existing.pair = pair;
      }
      if (
        (pair.liquidity?.usd ?? 0) > (existing.marketPair.liquidity?.usd ?? 0)
      ) {
        existing.marketPair = pair;
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
    for (const [mint, { pair, oldestPairTime, marketPair }] of entries) {
      const price = Number(marketPair.priceUsd);
      tokens.push({
        mint,
        dexName: pair.baseToken.name,
        dexSymbol: pair.baseToken.symbol,
        dexId: pair.dexId,
        pairCreatedAt: oldestPairTime,
        ...(marketPair.info?.imageUrl
          ? { imageUrl: marketPair.info.imageUrl }
          : {}),
        ...(Number.isFinite(price) && price > 0 ? { priceUsd: price } : {}),
        ...(typeof marketPair.liquidity?.usd === "number"
          ? { liquidityUsd: marketPair.liquidity.usd }
          : {}),
        ...(typeof marketPair.priceChange?.h24 === "number"
          ? { priceChange24h: marketPair.priceChange.h24 }
          : {}),
      });
      if (tokens.length >= DEX_LIMIT) break;
    }

    setDexCache(normalizedQuery, tokens);
    return tokens;
  } catch {
    return [];
  }
}
