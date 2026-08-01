import { NextRequest, NextResponse } from "next/server";
import {
  MIN_QUERY,
  MAX_QUERY,
  MAX_SOCIAL_URL,
  TokenResult,
} from "@/lib/types";
import { normalize } from "@/lib/normalize";
import { getSearchCache, setSearchCache } from "@/lib/cache";
import { searchTokens } from "@/lib/search";
import { buildTokenResults } from "@/lib/enrich-results";
import { isLikelyMintAddress } from "@/lib/solana";
import { deriveSearchTermFromMintMetadata } from "@/lib/mint-search";
import { getAssetBatch, getMintHeliusDataRpcFallback } from "@/lib/helius";
import { getJupiterTokenByMint } from "@/lib/jupiter";
import { isLikelySocialUrl, normalizeForSocialMatch } from "@/lib/social-url";
import { searchDexBySocialUrl } from "@/lib/dex-social";
import { ensurePollerStarted } from "@/lib/poller";
import { rateLimitRequest } from "@/lib/rate-limit";

interface MintScanPayload {
  results: TokenResult[];
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
}

/** Empty results are cached this long (seconds) so repeated misses skip the pipeline. */
const NEGATIVE_TTL = 60;

/** In-flight coalescing: concurrent identical cold searches share one pipeline run. */
const inflight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimitRequest(request.headers);
    if (limited) {
      return NextResponse.json(
        { error: limited.error },
        {
          status: limited.status,
          headers: { "Retry-After": String(limited.retryAfterSec) },
        }
      );
    }
    return await handleSearch(request);
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.error("[OGfinder] search route error:", err);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function handleSearch(request: NextRequest) {
  ensurePollerStarted();
  const start = Date.now();

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const isMint = isLikelyMintAddress(q);

  // ——— Social / website URL: tokens whose DexScreener profile includes this link ———
  if (isLikelySocialUrl(q)) {
    if (q.length > MAX_SOCIAL_URL) {
      return NextResponse.json(
        { error: `Social link must be at most ${MAX_SOCIAL_URL} characters` },
        { status: 400 }
      );
    }

    // URL-aware normalization — the token-name normalizer mangles URLs.
    const socialQuery = normalizeForSocialMatch(q) || q;
    const cacheKey = `social:${socialQuery}`;
    const cached = getSearchCache<TokenResult[]>(cacheKey);
    if (cached) {
      return NextResponse.json({
        results: cached,
        query: socialQuery,
        totalFound: cached.length,
        timing: Date.now() - start,
        mode: "social" as const,
      });
    }

    const final = await coalesce(cacheKey, async () => {
      const rawTokens = await searchDexBySocialUrl(q);
      if (rawTokens.length === 0) {
        setSearchCache(cacheKey, [] as TokenResult[], NEGATIVE_TTL);
        return [] as TokenResult[];
      }
      const results = await buildTokenResults(rawTokens, q, {
        rankBy: "marketcap",
      });
      setSearchCache(cacheKey, results);
      logSearch(
        socialQuery,
        results,
        Date.now() - start,
        rawTokens.length,
        results.length
      );
      return results;
    });

    return NextResponse.json({
      results: final,
      query: socialQuery,
      totalFound: final.length,
      timing: Date.now() - start,
      mode: "social" as const,
    });
  }

  if (!isMint && (q.length < MIN_QUERY || q.length > MAX_QUERY)) {
    return NextResponse.json(
      { error: `Text search must be ${MIN_QUERY}-${MAX_QUERY} characters` },
      { status: 400 }
    );
  }

  // ——— Mint scan: resolve metadata, search by name/symbol, rank vs OG ———
  if (isMint) {
    const cacheKey = `mint:${q}`;
    const cached = getSearchCache<MintScanPayload>(cacheKey);
    if (cached) {
      const scanned = cached.results.find((t) => t.mint === q);
      return NextResponse.json({
        results: cached.results,
        query: cached.query,
        totalFound: cached.results.length,
        timing: Date.now() - start,
        mode: "scan" as const,
        scannedMint: q,
        scanName: cached.scanName ?? scanned?.displayName ?? null,
        scanSymbol: cached.scanSymbol ?? scanned?.displaySymbol ?? null,
        isScannedOG: scanned?.rank === 1,
        scannedRank: scanned?.rank ?? null,
        originalInput: q,
      });
    }

    const outcome = await coalesce(cacheKey, () =>
      runMintScan(q, cacheKey, start)
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, results: [], totalFound: 0 },
        { status: outcome.status }
      );
    }

    const { results, query, scanName, scanSymbol } = outcome.payload;
    const scanned = results.find((t) => t.mint === q);

    return NextResponse.json({
      results,
      query,
      totalFound: results.length,
      timing: Date.now() - start,
      mode: "scan" as const,
      scannedMint: q,
      scanName,
      scanSymbol,
      isScannedOG: scanned?.rank === 1,
      scannedRank: scanned?.rank ?? null,
      originalInput: q,
    });
  }

  // ——— Text search ———
  const normalizedQuery = normalize(q);

  const cached = getSearchCache<TokenResult[]>(normalizedQuery);
  if (cached) {
    return NextResponse.json({
      results: cached,
      query: normalizedQuery,
      totalFound: cached.length,
      timing: Date.now() - start,
      mode: "search" as const,
    });
  }

  const final = await coalesce(normalizedQuery, async () => {
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

  return NextResponse.json({
    results: final,
    query: normalizedQuery,
    totalFound: final.length,
    timing: Date.now() - start,
    mode: "search" as const,
  });
}

type MintScanOutcome =
  | { ok: true; payload: MintScanPayload }
  | { ok: false; status: number; error: string };

async function runMintScan(
  q: string,
  cacheKey: string,
  start: number
): Promise<MintScanOutcome> {
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
