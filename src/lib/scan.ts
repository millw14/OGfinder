import { MAX_HELIUS, MIN_QUERY, RawToken, TokenResult } from "./types";
import { normalize } from "./normalize";
import { getSearchCache, setSearchCache } from "./cache";
import { searchTokens } from "./search";
import {
  annotateSafety,
  buildTokenResults,
  type AgeEscalationReport,
} from "./enrich-results";
import { deriveSearchTermsFromMintMetadata } from "./mint-search";
import {
  getAssetBatch,
  getMintHeliusDataRpcFallback,
  getTokenOffchainMeta,
  getTopHolderShare,
  getDeployer,
  getDeployerProfile,
} from "./helius";
import { getJupiterTokenByMint } from "./jupiter";
import { annotateLinkProvenance } from "./provenance";
import { recordOgFromScan } from "./og-registry";
import { ageOrderConfidence } from "./sort";

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
  /**
   * The creation ordering behind rank 1 is NOT proven — a token ranked below
   * the leader still carries a lower-bound age that could predate it. Consumers
   * (web hero, Telegram verdict, share card) must not render a crown while this
   * is set, even when the scanned mint is rank 1.
   */
  ageOrderUnproven?: true;
  /** Tokens in this payload whose unresolved age blocks that proof. */
  ageUnresolvedCount?: number;
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

/**
 * Dev-only trace of the deep age-resolution phase. The cap-overflow warning is
 * NOT here — enrich-results warns on that in every environment, because an
 * unresolved ambiguous token means the #1 answer is unproven.
 */
export function logAgeEscalation(report: AgeEscalationReport | null): void {
  if (!report || process.env.NODE_ENV !== "development") return;
  if (report.targets.length === 0) return;
  console.log(
    `[OGfinder] age escalation: deep-walked ${report.targets.length} in ` +
      `${report.elapsedMs}ms (resolved=${report.resolved} ` +
      `stillTruncated=${report.stillTruncated} ambiguous=${report.ambiguousTotal} ` +
      `dropped=${report.droppedByCap}) mints=${report.targets.join(",")}`
  );
}

/**
 * Merge the per-term cohorts of a mint scan into one candidate list.
 *
 * Round-robin rather than concatenation: each searchTokens call already returns
 * up to MAX_HELIUS candidates, so concatenating and slicing could drop the
 * ticker cohort entirely — precisely the tokens the second term exists to
 * surface. Interleaving guarantees every term keeps a share of the budget.
 * First occurrence of a mint wins; later hits only fill in missing Jupiter
 * metadata (same contract as searchTokens' own merge).
 */
export function mergeSearchCohorts(cohorts: RawToken[][]): RawToken[] {
  if (cohorts.length === 1) return cohorts[0];

  const merged = new Map<string, RawToken>();
  const depth = Math.max(0, ...cohorts.map((c) => c.length));
  for (let i = 0; i < depth && merged.size < MAX_HELIUS; i++) {
    for (const cohort of cohorts) {
      if (merged.size >= MAX_HELIUS) break;
      const token = cohort[i];
      if (!token) continue;
      const existing = merged.get(token.mint);
      if (!existing) {
        merged.set(token.mint, token);
        continue;
      }
      if (existing.jupName === undefined) existing.jupName = token.jupName;
      if (existing.jupSymbol === undefined) existing.jupSymbol = token.jupSymbol;
    }
  }
  return Array.from(merged.values());
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

  let searchTerms = deriveSearchTermsFromMintMetadata(
    h.heliusName,
    h.heliusSymbol
  );
  let searchTerm = searchTerms[0] ?? "";

  if (searchTerm.length < MIN_QUERY) {
    const jup = await getJupiterTokenByMint(q);
    if (jup) {
      h = {
        ...h,
        heliusName: jup.name,
        heliusSymbol: jup.symbol,
      };
      searchTerms = deriveSearchTermsFromMintMetadata(
        h.heliusName,
        h.heliusSymbol
      );
      searchTerm = searchTerms[0] ?? "";
    }
  }

  if (searchTerm.length < MIN_QUERY) {
    return {
      ok: false,
      status: 400,
      error: "This mint has no name/symbol long enough to search for duplicates",
    };
  }

  // Search the name AND the ticker: a copycat riding someone else's ticker is
  // invisible to a name-only search, which is how a newer token used to get
  // crowned (see deriveSearchTermsFromMintMetadata).
  let rawTokens = mergeSearchCohorts(
    await Promise.all(searchTerms.map((term) => searchTokens(term)))
  );
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
  let escalation: AgeEscalationReport | null = null;
  const final = await buildTokenResults(rawTokens, searchTerm, {
    scannedMint: q,
    onAgeEscalation: (r) => {
      escalation = r;
    },
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

    // Deployer intelligence — scanned mint only (serial-deployer and
    // fresh-wallet are the strongest rug tells). getDeployer reuses the
    // oldest signature the pipeline's own signature scan just cached, so a
    // cold scan adds ~3 RPC calls; both layers persist, repeats are free.
    // Both helpers swallow their failures and return null.
    if (scanned) {
      const deployer = await getDeployer(q);
      if (deployer) {
        scanned.deployerAddress = deployer;
        const profile = await getDeployerProfile(deployer);
        if (profile) {
          scanned.deployerTokensCreated = profile.tokensCreated;
          scanned.deployerWalletFirstSeenMs = profile.walletFirstSeenMs;
          if (profile.isOldWallet) scanned.deployerIsOldWallet = true;
        }
      }
    }

    // Socials + description from the mint's off-chain metadata JSON. SCANNED
    // MINT ONLY: exactly one extra request per cold scan (cached by URI), never
    // one per cohort token. The DAS description already hoisted by Helius wins;
    // this only fills a gap. Returns null on any failure — a token simply shows
    // no links, and the scan is unaffected.
    if (scanned && h.jsonUri) {
      const offchain = await getTokenOffchainMeta(h.jsonUri);
      if (offchain) {
        const { description, ...socials } = offchain;
        if (Object.keys(socials).length > 0) scanned.socials = socials;
        if (!scanned.description && description) {
          scanned.description = description;
        }
      }
    }

    // Re-assess with the holder + deployer signals that arrived after
    // enrichment. Extensions come from cache, so this costs no network. Both
    // are caution-tier, so a crown already awarded stays valid; this only
    // completes the flag list. Failures leave the earlier verdict in place.
    await annotateSafety(final, q);
  }

  // Whether the #1 answer is provable. scoreConfidence already stamped rank 1
  // (it saw the cohort before the MAX_RESULTS slice, so its flag wins); the
  // recompute here supplies the count for the payload. Pure — no extra I/O.
  const order = ageOrderConfidence(final);
  const orderUnproven = !order.proven || final[0]?.ageOrderUnproven === true;

  const payload: MintScanPayload = {
    results: final,
    query: normalizedQuery,
    scanName: h.heliusName,
    scanSymbol: h.heliusSymbol,
    ...(orderUnproven
      ? {
          ageOrderUnproven: true as const,
          ageUnresolvedCount: order.unresolvedCount,
        }
      : {}),
  };
  if (options?.fast) {
    setSearchCache(cacheKey, payload, FAST_TTL);
  } else {
    // Exact-name OG registry: remember this cohort's verified OG so repeat
    // scans (e.g. Telegram CA pastes) answer instantly. Try/caught inside —
    // full scans only, fast-phase ages are not trustworthy enough to record.
    recordOgFromScan(payload, q);
    setSearchCache(cacheKey, payload);
  }

  logSearch(
    normalizedQuery,
    final,
    Date.now() - start,
    rawTokens.length,
    final.length
  );
  logAgeEscalation(escalation);

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
