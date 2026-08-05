import { RawToken, DEX_LIMIT, DEX_TIMEOUT } from "./types";
import { fetchWithTimeout } from "./fetch";
import { normalize, skeleton, dexPairCreatedMs } from "./normalize";
import { getDexCache, setDexCache } from "./cache";

const DEX_URL = "https://api.dexscreener.com/latest/dex/search";

/** DexScreener trade counts for one time bucket. */
export interface DexTxnBucket {
  buys?: number;
  sells?: number;
}

interface DexPair {
  chainId: string;
  dexId: string;
  pairCreatedAt?: number;
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  priceChange?: { h24?: number };
  /**
   * Buy/sell counts per bucket — already in the payload we fetch, free.
   * h24 "buys with zero sells" is the strongest honeypot tell available
   * without simulating a swap.
   */
  txns?: {
    m5?: DexTxnBucket;
    h1?: DexTxnBucket;
    h6?: DexTxnBucket;
    h24?: DexTxnBucket;
  };
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

function count(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Buy/sell counts from ONE pair — always the pair the market data came from
 * (highest liquidity), never summed across pairs: mixing venues would hide a
 * dead-sells pattern behind a healthy pool.
 *
 * Each count is carried only when it is actually a number; a missing count
 * stays missing so the safety engine treats it as unchecked, not as zero.
 */
export function tradeCountFields(txns?: {
  h6?: DexTxnBucket;
  h24?: DexTxnBucket;
}): Pick<RawToken, "buys24h" | "sells24h" | "buys6h" | "sells6h"> {
  const b24 = count(txns?.h24?.buys);
  const s24 = count(txns?.h24?.sells);
  const b6 = count(txns?.h6?.buys);
  const s6 = count(txns?.h6?.sells);
  return {
    ...(b24 !== undefined ? { buys24h: b24 } : {}),
    ...(s24 !== undefined ? { sells24h: s24 } : {}),
    ...(b6 !== undefined ? { buys6h: b6 } : {}),
    ...(s6 !== undefined ? { sells6h: s6 } : {}),
  };
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
        ...(typeof marketPair.marketCap === "number"
          ? { dexMarketCapUsd: marketPair.marketCap }
          : {}),
        ...(typeof marketPair.fdv === "number"
          ? { dexFdvUsd: marketPair.fdv }
          : {}),
        ...(typeof marketPair.priceChange?.h24 === "number"
          ? { priceChange24h: marketPair.priceChange.h24 }
          : {}),
        ...tradeCountFields(marketPair.txns),
      });
      if (tokens.length >= DEX_LIMIT) break;
    }

    setDexCache(normalizedQuery, tokens);
    return tokens;
  } catch {
    return [];
  }
}
