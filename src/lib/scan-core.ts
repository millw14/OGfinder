import { TokenResult, MIN_QUERY } from "./types";
import { normalize } from "./normalize";
import { getSearchCache, setSearchCache } from "./cache";
import { searchTokens } from "./search";
import { buildTokenResults } from "./enrich-results";
import { deriveSearchTermFromMintMetadata } from "./mint-search";
import { getAssetBatch, getMintHeliusDataRpcFallback } from "./helius";
import { getJupiterTokenByMint } from "./jupiter";

/**
 * Shared scan/search core used by BOTH the web API route and the Telegram
 * bot, so a CA scanned in a group chat gets the exact same verdict as one
 * pasted on the site: same pipeline, same caches, same ranking.
 */

/** Empty results are cached this long (seconds) so repeated misses skip the pipeline. */
export const NEGATIVE_TTL = 60;

export interface MintScanPayload {
  results: TokenResult[];
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
}

/** Server verdict for a scanned mint — the single source of truth. */
export interface ScanVerdict {
  scannedMint: string;
  /** Full creation-ranked result list — results[0] is the OG. */
  results: TokenResult[];
  /** Normalized search term the duplicates were found with. */
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
  /** The scanned mint's own row, when it ranked. */
  scanned: TokenResult | undefined;
  isScannedOG: boolean;
  scannedRank: number | null;
  totalFound: number;
}

export type MintScanOutcome =
  | { ok: true; verdict: ScanVerdict }
  | { ok: false; status: number; error: string };

/** In-flight coalescing: concurrent identical cold searches share one pipeline run. */
const inflight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

function logSearch(
  normalizedQuery: string,
  final: TokenResult[],
  timing: number,
  rawCount: number,
  enrichedCount: number
) {
  if (process.env.NODE_ENV !== "development") return;
  console.log(
    `[OGfinder] q="${normalizedQuery}" raw=${rawCount} enriched=${enrichedCount} time=${timing}ms`
  );
  if (final.length > 0) {
    console.log(
      `[OGfinder] #1: "${final[0].displayName}" created=${final[0].createdAt} via=${final[0].timeSource} mint=${final[0].mint}`
    );
  }
}

function toVerdict(mint: string, payload: MintScanPayload): ScanVerdict {
  const scanned = payload.results.find((t) => t.mint === mint);
  return {
    scannedMint: mint,
    results: payload.results,
    query: payload.query,
    scanName: payload.scanName ?? scanned?.displayName ?? null,
    scanSymbol: payload.scanSymbol ?? scanned?.displaySymbol ?? null,
    scanned,
    isScannedOG: scanned?.rank === 1,
    scannedRank: scanned?.rank ?? null,
    totalFound: payload.results.length,
  };
}

/**
 * Scan a mint: resolve metadata, search same-name tokens, rank by age.
 * Cached (CACHE_SEARCH) and coalesced; safe to call from any surface.
 */
export async function scanMintCached(mint: string): Promise<MintScanOutcome> {
  const cacheKey = `mint:${mint}`;
  const cached = getSearchCache<MintScanPayload>(cacheKey);
  if (cached) {
    return { ok: true, verdict: toVerdict(mint, cached) };
  }

  const outcome = await coalesce(cacheKey, () => runMintScan(mint, cacheKey));
  if (!outcome.ok) return outcome;
  return { ok: true, verdict: toVerdict(mint, outcome.payload) };
}

type RawMintScanOutcome =
  | { ok: true; payload: MintScanPayload }
  | { ok: false; status: number; error: string };

async function runMintScan(
  q: string,
  cacheKey: string
): Promise<RawMintScanOutcome> {
  const start = Date.now();
  const pre = await getAssetBatch([q]);
  let h = pre.get(q);

  // DAS often omits unindexed mints; verify via RPC + Jupiter metadata.
  if (!h) {
    const fb = await getMintHeliusDataRpcFallback(q);
    if (fb) {
      const jup = await getJupiterTokenByMint(q);
      h = jup
        ? {
            ...fb,
            heliusName: jup.name,
            heliusSymbol: jup.symbol,
          }
        : fb;
    }
  }

  if (!h) {
    return { ok: false, status: 404, error: "Token not found on-chain" };
  }

  if (
    h.tokenInterface &&
    h.tokenInterface !== "FungibleToken" &&
    h.tokenInterface !== "FungibleAsset"
  ) {
    return {
      ok: false,
      status: 400,
      error: "Not a fungible token (NFT or unsupported type)",
    };
  }

  let searchTerm = deriveSearchTermFromMintMetadata(
    h.heliusName,
    h.heliusSymbol
  );

  if (searchTerm.length < MIN_QUERY) {
    const jup = await getJupiterTokenByMint(q);
    if (jup) {
      h = {
        ...h,
        heliusName: jup.name,
        heliusSymbol: jup.symbol,
      };
      searchTerm = deriveSearchTermFromMintMetadata(
        h.heliusName,
        h.heliusSymbol
      );
    }
  }

  if (searchTerm.length < MIN_QUERY) {
    return {
      ok: false,
      status: 400,
      error: "This mint has no name/symbol long enough to search for duplicates",
    };
  }

  let rawTokens = await searchTokens(searchTerm);
  const hasScanned = rawTokens.some((t) => t.mint === q);
  if (!hasScanned) {
    rawTokens = [
      ...rawTokens,
      {
        mint: q,
        jupName: h.heliusName ?? undefined,
        jupSymbol: h.heliusSymbol ?? undefined,
      },
    ];
  }

  const normalizedQuery = normalize(searchTerm);
  const final = await buildTokenResults(rawTokens, searchTerm, {
    scannedMint: q,
  });

  const payload: MintScanPayload = {
    results: final,
    query: normalizedQuery,
    scanName: h.heliusName,
    scanSymbol: h.heliusSymbol,
  };
  setSearchCache(cacheKey, payload);

  logSearch(
    normalizedQuery,
    final,
    Date.now() - start,
    rawTokens.length,
    final.length
  );

  return { ok: true, payload };
}

/**
 * Name/symbol search ranked oldest-first. Cached (CACHE_SEARCH, negative
 * misses for NEGATIVE_TTL) and coalesced — shared by web and bot.
 */
export async function searchByNameCached(q: string): Promise<TokenResult[]> {
  const normalizedQuery = normalize(q);

  const cached = getSearchCache<TokenResult[]>(normalizedQuery);
  if (cached) return cached;

  const start = Date.now();
  return coalesce(normalizedQuery, async () => {
    const rawTokens = await searchTokens(q);
    if (rawTokens.length === 0) {
      setSearchCache(normalizedQuery, [] as TokenResult[], NEGATIVE_TTL);
      return [] as TokenResult[];
    }
    const results = await buildTokenResults(rawTokens, q);
    setSearchCache(normalizedQuery, results);
    logSearch(
      normalizedQuery,
      results,
      Date.now() - start,
      rawTokens.length,
      results.length
    );
    return results;
  });
}
