import { MIN_QUERY, TokenResult } from "./types";
import { normalize } from "./normalize";
import { getSearchCache, setSearchCache } from "./cache";
import { searchTokens } from "./search";
import { buildTokenResults } from "./enrich-results";
import { deriveSearchTermFromMintMetadata } from "./mint-search";
import {
  getAssetBatch,
  getMintHeliusDataRpcFallback,
  getTopHolderShare,
} from "./helius";
import { getJupiterTokenByMint } from "./jupiter";
import { annotateLinkProvenance } from "./provenance";

/**
 * Mint-scan pipeline, extracted from the /api/search route so non-HTTP
 * callers (Telegram bot, poller) can scan without going through fetch or
 * per-IP rate limits. The HTTP route delegates here; behavior is identical.
 */

export interface MintScanPayload {
  results: TokenResult[];
  query: string;
  scanName: string | null;
  scanSymbol: string | null;
}

export type MintScanOutcome =
  | { ok: true; payload: MintScanPayload }
  | { ok: false; status: number; error: string };

/** Fast-phase results (signature scans skipped) are a stopgap — keep them briefly. */
export const FAST_TTL = 60;

/** In-flight coalescing: concurrent identical cold searches share one pipeline run. */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Map-backed coalescer shared by every caller (HTTP route and lib callers use
 * this same function, hence ONE inflight map process-wide).
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/** Dev-only search logging (thin logger shared with the route's text/social paths). */
export function logSearch(
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

export async function runMintScan(
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

/**
 * Bot-facing entry point: scan a mint with the same cache keys, cache-hit
 * precedence, and in-flight coalescing as the HTTP route. A full-cache hit is
 * served even for fast scans (fresher data, never worse).
 */
export async function scanMint(
  mint: string,
  opts?: { fast?: boolean }
): Promise<MintScanOutcome> {
  const start = Date.now();
  const cacheKey = `mint:${mint}`;
  const cached = getSearchCache<MintScanPayload>(cacheKey);
  if (cached) return { ok: true, payload: cached };

  if (opts?.fast) {
    const fastKey = `fast:${cacheKey}`;
    const cachedFast = getSearchCache<MintScanPayload>(fastKey);
    if (cachedFast) return { ok: true, payload: cachedFast };
    return coalesce(fastKey, () => runMintScan(mint, fastKey, start, { fast: true }));
  }

  return coalesce(cacheKey, () => runMintScan(mint, cacheKey, start));
}
