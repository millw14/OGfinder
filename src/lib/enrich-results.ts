import {
  RawToken,
  TokenResult,
  MAX_RESULTS,
  HeliusSlotData,
} from "./types";
import { getAssetBatch, getCreationSlot, getMintExtensions } from "./helius";
import { assessSafety } from "./safety";
import {
  dexPairCreatedMs,
  hasLookalikeChars,
  normalize,
  skeleton,
} from "./normalize";
import {
  sortByCreationTime,
  sortByVolumeUsd,
  sortByMarketCapLeaderboard,
  scoreConfidence,
  scoreVolumeRank,
  scoreMarketCapRank,
  resolveDisplayName,
  resolveDisplaySymbol,
} from "./sort";

const CREATION_SLOT_CONCURRENCY = 8;

/**
 * Run the safety checks on the tokens where they can change a decision: the
 * scanned mint and the rank-1 candidate (the only token that can wear the
 * crown). Bounded to ≤2 extra RPC calls per cold request — one cached
 * getAccountInfo per token — in EVERY mode, because the crown appears in text
 * search too.
 *
 * Every failure degrades to "unknown": a token whose checks did not run is
 * never described as clean, and a scan never breaks because a check failed.
 */
export async function annotateSafety(
  /** MUST be in rank order — index 0 is the rank-1 candidate. */
  tokens: TokenResult[],
  scannedMint?: string
): Promise<void> {
  const targets: TokenResult[] = [];
  const seen = new Set<string>();
  const add = (t: TokenResult | undefined) => {
    if (!t || seen.has(t.mint)) return;
    seen.add(t.mint);
    targets.push(t);
  };
  add(tokens[0]);
  if (scannedMint) add(tokens.find((t) => t.mint === scannedMint));
  if (targets.length === 0) return;

  await Promise.all(
    targets.map(async (token) => {
      try {
        const extensions = await getMintExtensions(token.mint);
        // The live mint account is fresher than the DAS index for authorities;
        // when it answered, prefer it (both describe the same on-chain field).
        if (extensions?.mintAuthorityActive !== undefined) {
          token.mintAuthorityActive = extensions.mintAuthorityActive;
        }
        if (extensions?.freezeAuthorityActive !== undefined) {
          token.freezeAuthorityActive = extensions.freezeAuthorityActive;
        }
        const assessment = assessSafety({ ...token, extensions });
        token.safetyLevel = assessment.level;
        token.safetyFlags = assessment.flags.map((f) => f.code);
      } catch {
        // A thrown check is an unrun check — say so, never imply "safe".
        token.safetyLevel = "unknown";
        token.safetyFlags = [];
      }
    })
  );
}

export async function buildTokenResults(
  rawTokens: RawToken[],
  queryForScore: string,
  options?: {
    scannedMint?: string;
    /** Default: oldest-first (OG). Social: use marketcap (MC → vol → age). */
    rankBy?: "creation" | "volume" | "marketcap";
    /** Fast phase: skip per-mint signature scans (DAS/DexScreener times only). */
    skipSignatureScan?: boolean;
  }
): Promise<TokenResult[]> {
  const rankBy = options?.rankBy ?? "creation";
  const skipSignatureScan = options?.skipSignatureScan === true;
  const mints = rawTokens.map((t) => t.mint);
  const heliusData = await getAssetBatch(mints);

  type Candidate = {
    raw: RawToken;
    h: HeliusSlotData | undefined;
    isScannedMint: boolean;
    supplyZero: boolean;
    createdAtMs: number | null;
    slot: number | null;
    timeSource: string;
  };

  const candidates: Candidate[] = [];

  for (const raw of rawTokens) {
    const h = heliusData.get(raw.mint);

    const isScannedMint =
      options?.scannedMint != null && raw.mint === options.scannedMint;

    if (h) {
      if (
        h.tokenInterface &&
        h.tokenInterface !== "FungibleToken" &&
        h.tokenInterface !== "FungibleAsset"
      ) {
        continue;
      }
    }

    // Zero-supply (fully burned) fungible tokens stay in — a burned token can be the OG
    const supplyZero = h?.supply != null && h.supply <= 0;

    let createdAtMs: number | null = null;
    let slot: number | null = h?.slot ?? null;
    let timeSource = "unknown";

    if (h?.createdAt) {
      const parsed = new Date(h.createdAt).getTime();
      if (!isNaN(parsed)) {
        createdAtMs = parsed;
        timeSource = "helius";
      }
    }

    const pairMs = dexPairCreatedMs(raw.pairCreatedAt);
    if (pairMs != null) {
      if (createdAtMs == null || pairMs < createdAtMs) {
        createdAtMs = pairMs;
        timeSource = "dexscreener";
      }
    }

    candidates.push({
      raw,
      h,
      isScannedMint,
      supplyZero,
      createdAtMs,
      slot,
      timeSource,
    });
  }

  // Homoglyph detection: normalized + skeleton forms of the query, computed once.
  const nq = normalize(queryForScore);
  const sq = skeleton(queryForScore);

  const sigResults: Awaited<ReturnType<typeof getCreationSlot>>[] = [];
  if (!skipSignatureScan) {
    for (let i = 0; i < candidates.length; i += CREATION_SLOT_CONCURRENCY) {
      const chunk = candidates.slice(i, i + CREATION_SLOT_CONCURRENCY);
      const part = await Promise.all(
        chunk.map((c) => getCreationSlot(c.raw.mint))
      );
      sigResults.push(...part);
    }
  }

  const enriched: TokenResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const sig = sigResults[i];
    let { createdAtMs, slot, timeSource } = c;
    let createdAtIsLowerBound = false;

    if (sig) {
      const sigMs = sig.blockTime * 1000;
      if (createdAtMs == null || sigMs < createdAtMs) {
        createdAtMs = sigMs;
        slot = sig.slot;
        timeSource = "signatures";
        createdAtIsLowerBound = sig.truncated;
      }
    }

    const displayName = resolveDisplayName(
      c.raw.dexName,
      c.raw.jupName,
      c.h?.heliusName
    );
    const displaySymbol = resolveDisplaySymbol(
      c.raw.dexSymbol,
      c.raw.jupSymbol,
      c.h?.heliusSymbol
    );

    // Homoglyph impersonation: the name carries lookalike/invisible chars AND
    // matches the query only after skeleton folding — never on exact
    // codepoints. The scanned mint derives the query from its own name (so it
    // always plain-matches itself); for it, carrying lookalike chars at all is
    // the suspicious signal.
    const lookalikeChars =
      hasLookalikeChars(displayName) || hasLookalikeChars(displaySymbol);
    const plainMatch =
      normalize(displayName).includes(nq) ||
      normalize(displaySymbol).includes(nq);
    const skelMatch =
      sq.length > 0 &&
      (skeleton(displayName).includes(sq) ||
        skeleton(displaySymbol).includes(sq));
    const homoglyphSuspect =
      lookalikeChars && (c.isScannedMint || (skelMatch && !plainMatch));

    enriched.push({
      mint: c.raw.mint,
      displayName,
      displaySymbol,
      slot,
      createdAtMs,
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      dexId: c.raw.dexId ?? null,
      confidence: 0,
      confidenceLabel: "",
      rank: 0,
      rankLabel: "",
      timeSource,
      volumeUsd24h:
        typeof c.raw.volumeUsd24h === "number" ? c.raw.volumeUsd24h : null,
      marketCapUsd:
        typeof c.raw.dexMarketCapUsd === "number"
          ? c.raw.dexMarketCapUsd
          : null,
      fdvUsd:
        typeof c.raw.dexFdvUsd === "number" ? c.raw.dexFdvUsd : null,
      imageUrl: typeof c.raw.imageUrl === "string" ? c.raw.imageUrl : null,
      priceUsd: typeof c.raw.priceUsd === "number" ? c.raw.priceUsd : null,
      liquidityUsd:
        typeof c.raw.liquidityUsd === "number" ? c.raw.liquidityUsd : null,
      priceChange24h:
        typeof c.raw.priceChange24h === "number"
          ? c.raw.priceChange24h
          : null,
      // Trade counts stay ABSENT when DexScreener did not report them —
      // null here would read as "we checked", and we did not.
      ...(typeof c.raw.buys24h === "number" ? { buys24h: c.raw.buys24h } : {}),
      ...(typeof c.raw.sells24h === "number"
        ? { sells24h: c.raw.sells24h }
        : {}),
      ...(typeof c.raw.buys6h === "number" ? { buys6h: c.raw.buys6h } : {}),
      ...(typeof c.raw.sells6h === "number" ? { sells6h: c.raw.sells6h } : {}),
      rankingMode:
        rankBy === "marketcap"
          ? "marketcap"
          : rankBy === "volume"
            ? "volume"
            : "creation",
      ...(c.isScannedMint ? { isScanned: true } : {}),
      ...(c.supplyZero ? { supplyZero: true } : {}),
      ...(homoglyphSuspect ? { homoglyphSuspect: true as const } : {}),
      ...(createdAtIsLowerBound ? { createdAtIsLowerBound: true } : {}),
      // Rug-risk signals from DAS — omitted when unknown (old cache entries / no DAS record)
      ...(c.h?.mintAuthorityActive !== undefined
        ? { mintAuthorityActive: c.h.mintAuthorityActive }
        : {}),
      ...(c.h?.freezeAuthorityActive !== undefined
        ? { freezeAuthorityActive: c.h.freezeAuthorityActive }
        : {}),
      ...(c.h?.metadataMutable !== undefined
        ? { metadataMutable: c.h.metadataMutable }
        : {}),
      // sortByCreationTime sends null createdAtMs to the bottom — no extra sort.
      ...(skipSignatureScan && createdAtMs == null
        ? { pendingAge: true as const }
        : {}),
    });
  }

  if (rankBy === "volume") {
    const sorted = sortByVolumeUsd(enriched);
    await annotateSafety(sorted, options?.scannedMint);
    const scored = scoreVolumeRank(sorted);
    return sliceWithPinnedScan(scored, options?.scannedMint);
  }

  if (rankBy === "marketcap") {
    const sorted = sortByMarketCapLeaderboard(enriched);
    await annotateSafety(sorted, options?.scannedMint);
    const scored = scoreMarketCapRank(sorted);
    return sliceWithPinnedScan(scored, options?.scannedMint);
  }

  const sorted = sortByCreationTime(enriched);
  // Runs BEFORE scoring: scoreConfidence gates the crown on safetyLevel, so
  // the verdict must already be on the token when the label is decided.
  await annotateSafety(sorted, options?.scannedMint);
  const scored = scoreConfidence(sorted, queryForScore);
  return sliceWithPinnedScan(scored, options?.scannedMint);
}

/**
 * Slice to MAX_RESULTS, but never drop the scanned mint: if it ranked outside
 * the window, append it with its true pre-slice rank (e.g. "#187 of 240").
 */
function sliceWithPinnedScan(
  scored: TokenResult[],
  scannedMint: string | undefined
): TokenResult[] {
  const window = scored.slice(0, MAX_RESULTS);
  if (!scannedMint || window.some((t) => t.mint === scannedMint)) {
    return window;
  }
  const scanned = scored.find((t) => t.mint === scannedMint);
  if (scanned) window.push(scanned);
  return window;
}
