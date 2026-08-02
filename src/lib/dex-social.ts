import { RawToken, DEX_TIMEOUT, DEX_LIMIT } from "./types";
import { fetchWithTimeout } from "./fetch";
import { dexPairCreatedMs } from "./normalize";
import {
  linkMatchesTarget,
  socialMatchTargets,
  searchTermsForDex,
  birdeyeSearchKeywords,
} from "./social-url";
import { searchByUrlDetailed, upsertTokenLinks, UrlIndexHit } from "./url-index";
import { getBirdeyeMetadataSingle, searchBirdeye } from "./birdeye";

const DEX_SEARCH = "https://api.dexscreener.com/latest/dex/search";
const TOKENS_V1 = "https://api.dexscreener.com/tokens/v1/solana";
const TOKEN_PROFILES_LATEST =
  "https://api.dexscreener.com/token-profiles/latest/v1";
const TOKEN_BOOSTS_LATEST =
  "https://api.dexscreener.com/token-boosts/latest/v1";

const MAX_CANDIDATE_MINTS = 400;
const TOKEN_BATCH = 25;
const SEARCH_CONCURRENCY = 4;

/** SQLite hits verified within this window bypass the live link re-check. */
const TRUST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface DexPairSocial {
  chainId: string;
  dexId: string;
  pairAddress?: string;
  baseToken: { address: string; name: string; symbol: string };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: {
    websites?: { url?: string }[];
    socials?: { url?: string; type?: string }[];
  };
}

interface DexSearchResponse {
  pairs: DexPairSocial[] | null;
}

interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  links?: { url?: string; type?: string; label?: string }[];
}

function collectLinkStrings(info?: DexPairSocial["info"]): string[] {
  const out: string[] = [];
  for (const w of info?.websites ?? []) {
    if (w?.url) out.push(w.url);
  }
  for (const s of info?.socials ?? []) {
    if (s?.url) out.push(s.url);
  }
  return out;
}

function pairMatchesTarget(
  pair: DexPairSocial,
  targets: string[]
): boolean {
  for (const link of collectLinkStrings(pair.info)) {
    if (linkMatchesTarget(link, targets)) return true;
  }
  return false;
}

async function fetchDexSearch(q: string): Promise<DexPairSocial[]> {
  try {
    const data = (await fetchWithTimeout(
      `${DEX_SEARCH}?q=${encodeURIComponent(q)}`,
      DEX_TIMEOUT
    )) as DexSearchResponse;
    if (!Array.isArray(data?.pairs)) return [];
    return data.pairs.filter((p) => p.chainId === "solana");
  } catch {
    return [];
  }
}

async function fetchTokenPairsBatched(
  mints: string[]
): Promise<DexPairSocial[]> {
  const out: DexPairSocial[] = [];
  for (let i = 0; i < mints.length; i += TOKEN_BATCH) {
    const chunk = mints.slice(i, i + TOKEN_BATCH);
    const url = `${TOKENS_V1}/${chunk.join(",")}`;
    try {
      const data = (await fetchWithTimeout(
        url,
        Math.max(DEX_TIMEOUT, 15000)
      )) as DexPairSocial[] | null;
      if (Array.isArray(data)) out.push(...data);
    } catch {
      /* skip batch */
    }
  }
  return out;
}

/**
 * Scan /token-profiles/latest and /token-boosts/latest for Solana tokens
 * whose links contain the target URL. Returns matching token addresses.
 * Also indexes ALL discovered profiles into SQLite for future lookups.
 */
async function findMintsFromLatestProfiles(
  targets: string[]
): Promise<string[]> {
  const results: string[] = [];
  const isDev = process.env.NODE_ENV === "development";
  const fetches = [TOKEN_PROFILES_LATEST, TOKEN_BOOSTS_LATEST].map(
    async (endpoint) => {
      try {
        const data = (await fetchWithTimeout(
          endpoint,
          DEX_TIMEOUT
        )) as TokenProfile[];
        if (!Array.isArray(data)) return;
        let indexed = 0;
        for (const tp of data) {
          if (tp.chainId !== "solana") continue;
          const urls: string[] = [];
          for (const link of tp.links ?? []) {
            if (link.url) urls.push(link.url);
          }
          // Check if this profile matches the target URL.
          let matched = false;
          for (const link of tp.links ?? []) {
            if (link.url && linkMatchesTarget(link.url, targets)) {
              matched = true;
              break;
            }
          }
          // Index every profile into SQLite for future searches — a live
          // link match counts as verification.
          if (urls.length > 0 && tp.tokenAddress) {
            try {
              upsertTokenLinks(
                tp.tokenAddress,
                urls,
                "dexscreener-profile",
                matched ? { verified: true } : undefined
              );
              indexed++;
            } catch { /* non-critical */ }
          }
          if (matched) results.push(tp.tokenAddress);
        }
        if (isDev) console.log(`[social] profile-scan ${endpoint.includes("boost") ? "boosts" : "profiles"}: indexed ${indexed}`);
      } catch {
        /* endpoint down or slow */
      }
    }
  );
  await Promise.all(fetches);
  return Array.from(new Set(results));
}

function pairMcUsd(p: DexPairSocial): number {
  return p.marketCap ?? p.fdv ?? 0;
}

function pairBeats(
  candidate: DexPairSocial,
  existing: DexPairSocial
): boolean {
  const mcC = pairMcUsd(candidate);
  const mcE = pairMcUsd(existing);
  if (mcC !== mcE) return mcC > mcE;
  const vC = candidate.volume?.h24 ?? 0;
  const vE = existing.volume?.h24 ?? 0;
  if (vC !== vE) return vC > vE;
  const tC = dexPairCreatedMs(candidate.pairCreatedAt) ?? 0;
  const tE = dexPairCreatedMs(existing.pairCreatedAt) ?? 0;
  return tC > tE;
}

function mergePairBest(
  map: Map<string, DexPairSocial>,
  p: DexPairSocial,
  keyMint: string
): void {
  const existing = map.get(keyMint);
  if (!existing || pairBeats(p, existing)) {
    map.set(keyMint, p);
  }
}

/**
 * Find Solana pairs whose DexScreener profile includes the URL in websites/socials.
 *
 * Three discovery channels run in parallel:
 *  1. DexScreener name search (finds tokens whose name overlaps with URL terms)
 *  2. /token-profiles/latest (catches very new coins with matching links)
 *  3. /token-boosts/latest  (same, boosted coins)
 *
 * If Dex has not indexed the pair or its socials yet, no results can be returned.
 */
export async function searchDexBySocialUrl(
  inputUrl: string
): Promise<RawToken[]> {
  const targets = socialMatchTargets(inputUrl);
  if (targets.length === 0) return [];

  const isDev = process.env.NODE_ENV === "development";
  const terms = searchTermsForDex(inputUrl);
  if (isDev) console.log(`[social] targets=`, targets, `terms=`, terms);

  const seenPairKeys = new Set<string>();
  const candidateMintSet = new Set<string>();
  const directHits = new Map<string, DexPairSocial>();
  /** Mints whose links matched the target live this request — safe to mark verified. */
  const verifiedNow = new Set<string>();

  // Channel 1: SQLite local index (instant).
  // Channel 2+3: latest token profiles (run simultaneously).
  // Channel 4: name-based DexScreener search (parallel batches).
  const sqliteHitsPromise = Promise.resolve().then(() => {
    try {
      return searchByUrlDetailed(targets);
    } catch {
      return [] as UrlIndexHit[];
    }
  });
  const profileMintsPromise = findMintsFromLatestProfiles(targets);
  const birdeyeMintsPromise = (async () => {
    const kws = birdeyeSearchKeywords(inputUrl);
    if (kws.length === 0) return [] as string[];
    const out = new Set<string>();
    for (const kw of kws.slice(0, 3)) {
      try {
        const items = await searchBirdeye(kw);
        for (const it of items) {
          if (it.address) out.add(it.address);
        }
      } catch {
        /* skip keyword */
      }
    }
    return Array.from(out);
  })();

  for (let i = 0; i < terms.length; i += SEARCH_CONCURRENCY) {
    const batch = terms.slice(i, i + SEARCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(fetchDexSearch));
    for (let bi = 0; bi < batchResults.length; bi++) {
      const pairs = batchResults[bi];
      if (isDev)
        console.log(
          `[social] q="${batch[bi]}" → ${pairs.length} solana pairs`
        );
      for (const p of pairs) {
        const mint = p.baseToken.address;
        const key = p.pairAddress ?? `${mint}:${p.dexId}`;
        if (seenPairKeys.has(key)) continue;
        seenPairKeys.add(key);

        if (p.info && pairMatchesTarget(p, targets)) {
          mergePairBest(directHits, p, mint);
          verifiedNow.add(mint);
        }

        candidateMintSet.add(mint);
      }
    }
    if (candidateMintSet.size >= MAX_CANDIDATE_MINTS) break;
  }

  // Merge mints from SQLite local index. Hits verified within the trust
  // window bypass the live re-check; stale hits stay candidates only.
  const sqliteHits = await sqliteHitsPromise;
  const trustCutoff = Date.now() - TRUST_MAX_AGE_MS;
  const sqliteTrustedMints: string[] = [];
  for (const h of sqliteHits) {
    candidateMintSet.add(h.mint);
    if (h.lastVerifiedAt !== null && h.lastVerifiedAt >= trustCutoff) {
      sqliteTrustedMints.push(h.mint);
    }
  }
  if (isDev && sqliteHits.length > 0)
    console.log(
      `[social] sqlite-index found ${sqliteHits.length} mints (${sqliteTrustedMints.length} trusted)`
    );

  const birdeyeMints = await birdeyeMintsPromise;
  if (isDev && birdeyeMints.length > 0)
    console.log(`[social] birdeye-search found ${birdeyeMints.length} mints`);
  for (const m of birdeyeMints) candidateMintSet.add(m);

  // Merge mints discovered from latest profiles.
  const profileMints = await profileMintsPromise;
  if (isDev && profileMints.length > 0)
    console.log(`[social] profile-scan found ${profileMints.length} mints`);
  for (const m of profileMints) candidateMintSet.add(m);

  const candidateMints = Array.from(candidateMintSet).slice(
    0,
    MAX_CANDIDATE_MINTS
  );

  if (isDev)
    console.log(
      `[social] directHits=${directHits.size} candidates=${candidateMints.length}`
    );

  // Recently-verified SQLite hits + profile-scan matches are pre-verified
  // URL matches. They bypass the pairMatchesTarget re-check below.
  const trustedMints = new Set<string>();
  for (const m of sqliteTrustedMints) trustedMints.add(m);
  for (const m of profileMints) trustedMints.add(m);
  if (isDev && trustedMints.size > 0)
    console.log(`[social] trusted (pre-verified) mints: ${trustedMints.size}`);

  const byMint = new Map<string, DexPairSocial>(directHits);

  if (candidateMints.length > 0) {
    const detailedPairs = await fetchTokenPairsBatched(candidateMints);
    if (isDev)
      console.log(
        `[social] tokens/v1 returned ${detailedPairs.length} pairs`
      );
    for (const p of detailedPairs) {
      if (p.chainId !== "solana") continue;
      const mint = p.baseToken.address;
      const isTrusted = trustedMints.has(mint);
      const matches = pairMatchesTarget(p, targets);
      if (!isTrusted && !matches) continue;
      if (matches) verifiedNow.add(mint);
      mergePairBest(byMint, p, mint);
    }
  }

  // For trusted mints that DexScreener tokens/v1 didn't return any pair data,
  // fetch Birdeye metadata to backfill links and add them as minimal results.
  const unmatchedTrusted = Array.from(trustedMints).filter(
    (m) => !byMint.has(m)
  );
  if (unmatchedTrusted.length > 0) {
    if (isDev)
      console.log(
        `[social] ${unmatchedTrusted.length} trusted mints not in DexScreener, enriching via Birdeye`
      );
    const birdeyeEnrichPromises = unmatchedTrusted
      .slice(0, 10)
      .map(async (mint) => {
        try {
          const urls = await getBirdeyeMetadataSingle(mint);
          if (urls.length > 0) {
            upsertTokenLinks(mint, urls, "birdeye-enrich");
          }
        } catch {
          /* skip */
        }
      });
    await Promise.all(birdeyeEnrichPromises);
  }

  // Index links discovered from DexScreener tokens/v1 for future lookups.
  // Mints whose links matched live this request refresh their verification.
  byMint.forEach((pair, mint) => {
    const urls = collectLinkStrings(pair.info);
    if (urls.length > 0) {
      try {
        upsertTokenLinks(
          mint,
          urls,
          "dexscreener-search",
          verifiedNow.has(mint) ? { verified: true } : undefined
        );
      } catch {
        /* non-critical */
      }
    }
  });

  if (isDev)
    console.log(
      `[social] final matched mints: ${byMint.size}, unmatched trusted: ${unmatchedTrusted.length}`
    );

  const merged = Array.from(byMint.values()).sort((a, b) => {
    const mcA = pairMcUsd(a);
    const mcB = pairMcUsd(b);
    if (mcB !== mcA) return mcB - mcA;
    const vA = a.volume?.h24 ?? 0;
    const vB = b.volume?.h24 ?? 0;
    if (vB !== vA) return vB - vA;
    const tA = dexPairCreatedMs(a.pairCreatedAt) ?? 0;
    const tB = dexPairCreatedMs(b.pairCreatedAt) ?? 0;
    return tB - tA;
  });

  const tokens: RawToken[] = [];
  for (const pair of merged) {
    if (tokens.length >= DEX_LIMIT) break;
    const pairMs = dexPairCreatedMs(pair.pairCreatedAt);
    tokens.push({
      mint: pair.baseToken.address,
      dexName: pair.baseToken.name,
      dexSymbol: pair.baseToken.symbol,
      dexId: pair.dexId,
      pairCreatedAt: pairMs,
      volumeUsd24h:
        typeof pair.volume?.h24 === "number" ? pair.volume.h24 : undefined,
      dexMarketCapUsd:
        typeof pair.marketCap === "number" ? pair.marketCap : undefined,
      dexFdvUsd: typeof pair.fdv === "number" ? pair.fdv : undefined,
    });
  }

  // Trusted mints with no DexScreener pair data — still surface them.
  for (const mint of unmatchedTrusted) {
    if (tokens.length >= DEX_LIMIT) break;
    if (tokens.some((t) => t.mint === mint)) continue;
    tokens.push({ mint });
  }

  return tokens;
}
