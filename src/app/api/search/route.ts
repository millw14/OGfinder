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
import {
  getAssetBatch,
  getMintHeliusDataRpcFallback,
  getTopHolderShare,
} from "@/lib/helius";
import { getJupiterTokenByMint } from "@/lib/jupiter";
import { isLikelySocialUrl, normalizeForSocialMatch } from "@/lib/social-url";
import { searchDexBySocialUrl } from "@/lib/dex-social";
import { annotateLinkProvenance } from "@/lib/provenance";
import {
  captureSnapshot,
  detectAndRecordFlip,
  getSearchHistory,
} from "@/lib/snapshots";
import { ensurePollerStarted } from "@/lib/poller";
import {
  rateLimitRequest,
  clientIpFromHeaders,
  registerPrepaidSearch,
  consumePrepaidSearch,
} from "@/lib/rate-limit";
import {
  runWithFailureCollection,
  currentFailures,
} from "@/lib/provider-health";

interface MintScanPayload {
  results: TokenResult[];
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
}

/** Empty results are cached this long (seconds) so repeated misses skip the pipeline. */
const NEGATIVE_TTL = 60;

/** Fast-phase results (signature scans skipped) are a stopgap — keep them briefly. */
const FAST_TTL = 60;

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

/** Optional degraded-provider list for the active request's responses. */
function degradedFields(): { degraded?: string[] } {
  const failures = currentFailures();
  return failures.length ? { degraded: failures } : {};
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
    // One rate token per logical search: the fast request pays and prepays its
    // full follow-up; a full request with a matching prepaid entry rides free.
    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const wantFast = request.nextUrl.searchParams.get("phase") === "fast";
    const ip = clientIpFromHeaders(request.headers);
    if (wantFast || !consumePrepaidSearch(ip, q)) {
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
      if (wantFast) registerPrepaidSearch(ip, q);
    }
    // Collect provider failures for this request so responses can carry a
    // degraded list. Coalesce joiners and cache hits omit it (documented).
    const { value } = await runWithFailureCollection(() =>
      handleSearch(request)
    );
    return value;
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
  // Fast phase: same pipeline minus signature scans, for all three modes.
  // Full-cache hits are always served without the enriching flag.
  const wantFast = request.nextUrl.searchParams.get("phase") === "fast";

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

    // Fast phase: same social pipeline minus signature scans.
    if (wantFast) {
      const fastKey = `fast:${cacheKey}`;
      const cachedFast = getSearchCache<TokenResult[]>(fastKey);
      const fastResults =
        cachedFast ??
        (await coalesce(fastKey, async () => {
          const rawTokens = await searchDexBySocialUrl(q);
          if (rawTokens.length === 0) {
            setSearchCache(fastKey, [] as TokenResult[], FAST_TTL);
            return [] as TokenResult[];
          }
          const results = await buildTokenResults(rawTokens, q, {
            rankBy: "marketcap",
            skipSignatureScan: true,
          });
          setSearchCache(fastKey, results, FAST_TTL);
          return results;
        }));

      return NextResponse.json({
        results: fastResults,
        query: socialQuery,
        totalFound: fastResults.length,
        timing: Date.now() - start,
        mode: "social" as const,
        phase: "fast" as const,
        enriching: true,
        ...degradedFields(),
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
      ...degradedFields(),
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
      // Full cache hit serves final data even for phase=fast — no enriching flag,
      // so the client skips its follow-up full request.
      return NextResponse.json(scanResponseBody(cached, q, start, false));
    }

    // Fast phase: full pipeline minus signature scans — preliminary verdict.
    if (wantFast) {
      const fastKey = `fast:${cacheKey}`;
      const cachedFast = getSearchCache<MintScanPayload>(fastKey);
      if (cachedFast) {
        return NextResponse.json(scanResponseBody(cachedFast, q, start, true));
      }

      const fastOutcome = await coalesce(fastKey, () =>
        runMintScan(q, fastKey, start, { fast: true })
      );
      if (!fastOutcome.ok) {
        return NextResponse.json(
          { error: fastOutcome.error, results: [], totalFound: 0 },
          { status: fastOutcome.status }
        );
      }
      return NextResponse.json(
        scanResponseBody(fastOutcome.payload, q, start, true)
      );
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

    return NextResponse.json(scanResponseBody(outcome.payload, q, start, false));
  }

  // ——— Text search ———
  const normalizedQuery = normalize(q);

  const cached = getSearchCache<TokenResult[]>(normalizedQuery);
  if (cached) {
    // Full cache hit serves final data even for phase=fast — no enriching flag,
    // so the client skips its follow-up full request.
    return NextResponse.json({
      results: cached,
      query: normalizedQuery,
      totalFound: cached.length,
      timing: Date.now() - start,
      mode: "search" as const,
      history: getSearchHistory(normalizedQuery),
    });
  }

  // Fast phase: full pipeline minus signature scans, cached separately.
  if (wantFast) {
    const fastKey = `fast:${normalizedQuery}`;
    const cachedFast = getSearchCache<TokenResult[]>(fastKey);
    const fastResults =
      cachedFast ??
      (await coalesce(fastKey, async () => {
        const rawTokens = await searchTokens(q);
        if (rawTokens.length === 0) {
          setSearchCache(fastKey, [] as TokenResult[], FAST_TTL);
          return [] as TokenResult[];
        }
        const results = await buildTokenResults(rawTokens, q, {
          skipSignatureScan: true,
        });
        setSearchCache(fastKey, results, FAST_TTL);
        return results;
      }));

    return NextResponse.json({
      results: fastResults,
      query: normalizedQuery,
      totalFound: fastResults.length,
      timing: Date.now() - start,
      mode: "search" as const,
      phase: "fast" as const,
      enriching: true,
      history: getSearchHistory(normalizedQuery),
      ...degradedFields(),
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
    // OG-flip history: snapshot the leaderboard and alert on new flips. Both
    // calls swallow their own failures; detect must follow capture directly
    // (synchronous pair — the capture marker links them).
    captureSnapshot(normalizedQuery, results);
    detectAndRecordFlip(normalizedQuery);
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
    history: getSearchHistory(normalizedQuery),
    ...degradedFields(),
  });
}

/** Scan response JSON — fast responses add phase/enriching/verdictPreliminary. */
function scanResponseBody(
  payload: MintScanPayload,
  q: string,
  start: number,
  fast: boolean
) {
  const scanned = payload.results.find((t) => t.mint === q);
  return {
    results: payload.results,
    query: payload.query,
    totalFound: payload.results.length,
    timing: Date.now() - start,
    mode: "scan" as const,
    scannedMint: q,
    scanName: payload.scanName ?? scanned?.displayName ?? null,
    scanSymbol: payload.scanSymbol ?? scanned?.displaySymbol ?? null,
    isScannedOG: scanned?.rank === 1,
    scannedRank: scanned?.rank ?? null,
    originalInput: q,
    ...degradedFields(),
    ...(fast
      ? {
          phase: "fast" as const,
          enriching: true,
          verdictPreliminary: true,
        }
      : {}),
  };
}

type MintScanOutcome =
  | { ok: true; payload: MintScanPayload }
  | { ok: false; status: number; error: string };

async function runMintScan(
  q: string,
  cacheKey: string,
  start: number,
  options?: { fast?: boolean }
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
    ...(options?.fast ? { skipSignatureScan: true } : {}),
  });
  // Earliest-link-claim evidence from the local index — sub-ms SQLite read,
  // runs on both fast and full paths (try/caught inside the lib).
  annotateLinkProvenance(final, q);

  // Holder concentration — full scans only (cost control): scanned mint + OG,
  // deduped when they're the same token. Baked into the cache payload below;
  // any RPC failure just leaves topHolderPct absent.
  if (!options?.fast) {
    const og = final.length > 0 ? final[0] : undefined;
    const scanned = final.find((t) => t.mint === q);
    const jobs: { token: TokenResult; supply: number | null }[] = [];
    if (scanned) jobs.push({ token: scanned, supply: h.supply });
    if (og && og.mint !== q) {
      // DAS supply is usually a warm heliusMeta cache hit from enrichment;
      // null falls back to getTokenSupply inside getTopHolderShare.
      const ogMeta = (await getAssetBatch([og.mint])).get(og.mint);
      jobs.push({ token: og, supply: ogMeta?.supply ?? null });
    }
    const shares = await Promise.all(
      jobs.map((job) => getTopHolderShare(job.token.mint, job.supply))
    );
    shares.forEach((share, i) => {
      if (share) jobs[i].token.topHolderPct = share.topTenPct;
    });
  }

  const payload: MintScanPayload = {
    results: final,
    query: normalizedQuery,
    scanName: h.heliusName,
    scanSymbol: h.heliusSymbol,
  };
  if (options?.fast) {
    setSearchCache(cacheKey, payload, FAST_TTL);
  } else {
    setSearchCache(cacheKey, payload);
  }

  logSearch(
    normalizedQuery,
    final,
    Date.now() - start,
    rawTokens.length,
    final.length
  );

  return { ok: true, payload };
}
