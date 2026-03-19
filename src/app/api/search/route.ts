import { NextRequest, NextResponse } from "next/server";
import { MIN_QUERY, MAX_QUERY, MAX_RESULTS, TokenResult } from "@/lib/types";
import { normalize } from "@/lib/normalize";
import { getSearchCache, setSearchCache } from "@/lib/cache";
import { searchTokens } from "@/lib/search";
import { getAssetBatch, getCreationSlot } from "@/lib/helius";
import {
  sortByCreationTime,
  scoreConfidence,
  resolveDisplayName,
  resolveDisplaySymbol,
} from "@/lib/sort";

export async function GET(request: NextRequest) {
  const start = Date.now();

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
    return NextResponse.json(
      { error: `Query must be ${MIN_QUERY}-${MAX_QUERY} characters` },
      { status: 400 }
    );
  }

  const normalizedQuery = normalize(q);

  const cached = getSearchCache<TokenResult[]>(normalizedQuery);
  if (cached) {
    return NextResponse.json({
      results: cached,
      query: normalizedQuery,
      totalFound: cached.length,
      timing: Date.now() - start,
    });
  }

  const rawTokens = await searchTokens(q);

  if (rawTokens.length === 0) {
    return NextResponse.json({
      results: [],
      query: normalizedQuery,
      totalFound: 0,
      timing: Date.now() - start,
    });
  }

  const mints = rawTokens.map((t) => t.mint);
  const heliusData = await getAssetBatch(mints);

  const enriched: TokenResult[] = [];

  for (const raw of rawTokens) {
    const h = heliusData.get(raw.mint);

    if (h) {
      if (
        h.tokenInterface &&
        h.tokenInterface !== "FungibleToken" &&
        h.tokenInterface !== "FungibleAsset"
      ) {
        continue;
      }
      if (h.supply != null && h.supply <= 0) {
        continue;
      }
    }

    // Creation time: use the EARLIEST available timestamp.
    // - Helius created_at (usually null for fungible tokens)
    // - DexScreener pairCreatedAt (pair listing time, good proxy)
    // - getSignaturesForAddress blockTime (actual first tx, expensive)
    // We take the minimum of all available sources.
    let createdAtMs: number | null = null;
    let slot: number | null = h?.slot ?? null;
    let timeSource = "unknown";

    // Source 1: Helius created_at
    if (h?.createdAt) {
      const parsed = new Date(h.createdAt).getTime();
      if (!isNaN(parsed)) {
        createdAtMs = parsed;
        timeSource = "helius";
      }
    }

    // Source 2: DexScreener pairCreatedAt
    if (raw.pairCreatedAt) {
      if (createdAtMs == null || raw.pairCreatedAt < createdAtMs) {
        createdAtMs = raw.pairCreatedAt;
        timeSource = "dexscreener";
      }
    }

    // Source 3: getSignaturesForAddress (only if no time yet — expensive)
    if (createdAtMs == null) {
      const fallback = await getCreationSlot(raw.mint);
      if (fallback) {
        const sigTime = fallback.blockTime * 1000;
        if (createdAtMs == null || sigTime < createdAtMs) {
          createdAtMs = sigTime;
          slot = fallback.slot;
          timeSource = "signatures";
        }
      }
    }

    enriched.push({
      mint: raw.mint,
      displayName: resolveDisplayName(
        raw.dexName,
        raw.jupName,
        h?.heliusName
      ),
      displaySymbol: resolveDisplaySymbol(
        raw.dexSymbol,
        raw.jupSymbol,
        h?.heliusSymbol
      ),
      slot,
      createdAtMs,
      createdAt: createdAtMs
        ? new Date(createdAtMs).toISOString()
        : null,
      dexId: raw.dexId ?? null,
      confidence: 0,
      confidenceLabel: "",
      rank: 0,
      rankLabel: "",
      timeSource,
    });
  }

  const sorted = sortByCreationTime(enriched);
  const scored = scoreConfidence(sorted, q);
  const final = scored.slice(0, MAX_RESULTS);

  setSearchCache(normalizedQuery, final);

  const timing = Date.now() - start;

  if (process.env.NODE_ENV === "development") {
    const dexCount = rawTokens.filter((t) => t.dexName).length;
    const jupCount = rawTokens.filter((t) => t.jupName).length;
    const sources = enriched.reduce(
      (acc, t) => {
        acc[t.timeSource] = (acc[t.timeSource] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    console.log(
      `[OGfinder] q="${normalizedQuery}" dex=${dexCount} jup=${jupCount} enriched=${enriched.length} sources=${JSON.stringify(sources)} time=${timing}ms`
    );
    if (final.length > 0) {
      console.log(
        `[OGfinder] #1: "${final[0].displayName}" created=${final[0].createdAt} via=${final[0].timeSource} mint=${final[0].mint}`
      );
    }
  }

  return NextResponse.json({
    results: final,
    query: normalizedQuery,
    totalFound: final.length,
    timing,
  });
}
