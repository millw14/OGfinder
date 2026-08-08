import { NextRequest, NextResponse } from "next/server";
import {
  MIN_QUERY,
  MAX_QUERY,
  MAX_SOCIAL_URL,
  TokenResult,
} from "@/lib/types";
import { normalize } from "@/lib/normalize";
import { ageOrderConfidence } from "@/lib/sort";
import { getSearchCache, setSearchCache } from "@/lib/cache";
import { searchTokens } from "@/lib/search";
import { buildTokenResults } from "@/lib/enrich-results";
import { isLikelyMintAddress } from "@/lib/solana";
import { isLikelySocialUrl, normalizeForSocialMatch } from "@/lib/social-url";
import { searchDexBySocialUrl } from "@/lib/dex-social";
import {
  MintScanPayload,
  runMintScan,
  coalesce,
  FAST_TTL,
  logSearch,
} from "@/lib/scan";
import {
  captureSnapshot,
  detectAndRecordFlip,
  getSearchHistory,
} from "@/lib/snapshots";
import { ensurePollerStarted } from "@/lib/poller";
import { ensureTelegramLoopStarted } from "@/lib/telegram";
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

/** Empty results are cached this long (seconds) so repeated misses skip the pipeline. */
const NEGATIVE_TTL = 60;

/** Optional degraded-provider list for the active request's responses. */
function degradedFields(): { degraded?: string[] } {
  const failures = currentFailures();
  return failures.length ? { degraded: failures } : {};
}

/**
 * Order-confidence fields for CREATION-ranked responses (text search + scan).
 * Present only when the #1 answer is unproven, so every existing proven
 * response is byte-identical to before. Pure and cheap — one pass, no I/O.
 * Not emitted for social mode, which ranks by market cap, not age.
 */
function ageOrderFields(
  results: TokenResult[]
): { ageOrderUnproven?: true; ageUnresolvedCount?: number } {
  const order = ageOrderConfidence(results);
  // The rank-1 stamp is authoritative: scoreConfidence saw the cohort before
  // it was sliced to MAX_RESULTS, so it can know about tokens absent here.
  if (order.proven && results[0]?.ageOrderUnproven !== true) return {};
  return { ageOrderUnproven: true, ageUnresolvedCount: order.unresolvedCount };
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
  // Route fallback for the Telegram loop too (self-gated; see telegram.ts).
  ensureTelegramLoopStarted();
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
      ...ageOrderFields(cached),
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
      ...ageOrderFields(fastResults),
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
    ...ageOrderFields(final),
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
    // isScannedOG keeps its literal meaning — "the scanned mint is rank 1" —
    // and is deliberately NOT flipped when the order is unproven: rank is a
    // fact about our data. What changes is that the response now says, in its
    // own field, that rank 1 is not provable, so no consumer may crown it.
    isScannedOG: scanned?.rank === 1,
    scannedRank: scanned?.rank ?? null,
    ...(payload.ageOrderUnproven
      ? {
          ageOrderUnproven: true as const,
          ...(payload.ageUnresolvedCount != null
            ? { ageUnresolvedCount: payload.ageUnresolvedCount }
            : {}),
        }
      : ageOrderFields(payload.results)),
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

