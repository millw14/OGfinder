import { NextRequest, NextResponse } from "next/server";
import {
  MIN_QUERY,
  MAX_QUERY,
  MAX_MINT_LEN,
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

interface MintScanPayload {
  results: TokenResult[];
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
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
  const start = Date.now();

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const isMint = isLikelyMintAddress(q);

  if (!isMint) {
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
      return NextResponse.json(
        { error: `Text search must be ${MIN_QUERY}-${MAX_QUERY} characters` },
        { status: 400 }
      );
    }
  } else {
    if (q.length < 32 || q.length > MAX_MINT_LEN) {
      return NextResponse.json(
        { error: `Mint must be 32–${MAX_MINT_LEN} base58 characters` },
        { status: 400 }
      );
    }
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
      return NextResponse.json(
        { error: "Token not found on-chain", results: [], totalFound: 0 },
        { status: 404 }
      );
    }

    if (
      h.tokenInterface &&
      h.tokenInterface !== "FungibleToken" &&
      h.tokenInterface !== "FungibleAsset"
    ) {
      return NextResponse.json(
        {
          error: "Not a fungible token (NFT or unsupported type)",
          results: [],
          totalFound: 0,
        },
        { status: 400 }
      );
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
      return NextResponse.json(
        {
          error: "This mint has no name/symbol long enough to search for duplicates",
          results: [],
          totalFound: 0,
        },
        { status: 400 }
      );
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

    setSearchCache(cacheKey, {
      results: final,
      query: normalizedQuery,
      scanName: h.heliusName,
      scanSymbol: h.heliusSymbol,
    } satisfies MintScanPayload);

    const scanned = final.find((t) => t.mint === q);
    const timing = Date.now() - start;

    logSearch(normalizedQuery, final, timing, rawTokens.length, final.length);

    return NextResponse.json({
      results: final,
      query: normalizedQuery,
      totalFound: final.length,
      timing,
      mode: "scan" as const,
      scannedMint: q,
      scanName: h.heliusName,
      scanSymbol: h.heliusSymbol,
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

  const rawTokens = await searchTokens(q);

  if (rawTokens.length === 0) {
    return NextResponse.json({
      results: [],
      query: normalizedQuery,
      totalFound: 0,
      timing: Date.now() - start,
      mode: "search" as const,
    });
  }

  const final = await buildTokenResults(rawTokens, q);
  setSearchCache(normalizedQuery, final);

  const timing = Date.now() - start;
  logSearch(normalizedQuery, final, timing, rawTokens.length, final.length);

  return NextResponse.json({
    results: final,
    query: normalizedQuery,
    totalFound: final.length,
    timing,
    mode: "search" as const,
  });
}
