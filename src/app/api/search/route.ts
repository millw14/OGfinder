import { NextRequest, NextResponse } from "next/server";
import {
  MIN_QUERY,
  MAX_QUERY,
  MAX_SOCIAL_URL,
  TokenResult,
} from "@/lib/types";
import { normalize } from "@/lib/normalize";
import { getSearchCache, setSearchCache } from "@/lib/cache";
import {
  scanMintCached,
  searchByNameCached,
  coalesce,
  NEGATIVE_TTL,
} from "@/lib/scan-core";
import { buildTokenResults } from "@/lib/enrich-results";
import { isLikelyMintAddress } from "@/lib/solana";
import { isLikelySocialUrl, normalizeForSocialMatch } from "@/lib/social-url";
import { searchDexBySocialUrl } from "@/lib/dex-social";
import { ensurePollerStarted } from "@/lib/poller";
import { rateLimitRequest } from "@/lib/rate-limit";

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
    const outcome = await scanMintCached(q);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, results: [], totalFound: 0 },
        { status: outcome.status }
      );
    }

    const v = outcome.verdict;
    return NextResponse.json({
      results: v.results,
      query: v.query,
      totalFound: v.totalFound,
      timing: Date.now() - start,
      mode: "scan" as const,
      scannedMint: v.scannedMint,
      scanName: v.scanName,
      scanSymbol: v.scanSymbol,
      isScannedOG: v.isScannedOG,
      scannedRank: v.scannedRank,
      originalInput: q,
    });
  }

  // ——— Text search ———
  const final = await searchByNameCached(q);

  return NextResponse.json({
    results: final,
    query: normalize(q),
    totalFound: final.length,
    timing: Date.now() - start,
    mode: "search" as const,
  });
}
