import {
  RawToken,
  TokenResult,
  MAX_RESULTS,
  HeliusSlotData,
  DEEP_SIG_PAGES,
  MAX_DEEP_ESCALATIONS,
  DEEP_PHASE_BUDGET_MS,
} from "./types";
import {
  getAssetBatch,
  getCreationSlot,
  getMintExtensions,
  isSafeImageUrl,
  type CreationSlotResult,
} from "./helius";
import { assessSafety } from "./safety";
import {
  dexPairCreatedMs,
  hasLookalikeChars,
  normalize,
  skeleton,
} from "./normalize";
import { isCrownEligible, tokenMatchTier } from "./match";
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
 * Which logo a token shows, and where it came from.
 *
 * DexScreener's `info.imageUrl` wins: it is the market-facing logo, curated and
 * CDN-hosted. But most mints have no DexScreener profile image at all, which is
 * why cohorts used to render as rows of blank squares — so the DAS/on-chain
 * image (already on the getAssetBatch response we pay for anyway) is the
 * fallback, and it is what actually gives most of a cohort a picture.
 *
 * Both sources are third-party strings, so both are http/https-validated here;
 * an unusable DexScreener URL falls through to DAS rather than blanking the
 * card. null = this token genuinely has no logo we can show.
 *
 * Pure — exported for tests.
 */
export function resolveTokenImage(
  dexImageUrl: unknown,
  dasImageUrl: unknown
): { imageUrl: string; imageSource: "dexscreener" | "das" } | null {
  if (isSafeImageUrl(dexImageUrl)) {
    return { imageUrl: dexImageUrl.trim(), imageSource: "dexscreener" };
  }
  if (isSafeImageUrl(dasImageUrl)) {
    return { imageUrl: dasImageUrl.trim(), imageSource: "das" };
  }
  return null;
}

/** Creation time known from metadata alone, before any signature walk. */
export interface AgeBaseline {
  createdAtMs: number | null;
  slot: number | null;
  timeSource: string;
}

export interface CanonicalAge {
  createdAtMs: number | null;
  slot: number | null;
  timeSource: string;
  /** True = true creation is AT OR BEFORE createdAtMs, by an unknown amount. */
  createdAtIsLowerBound: boolean;
}

/**
 * Canonical creation time: the OLDEST of the metadata baseline and the
 * oldest-signature walk. Pure, and the single definition of that merge — the
 * bulk pass and the deep-resolution pass both go through here, so an improved
 * walk recomputes exactly what the first pass computed.
 *
 * createdAtIsLowerBound is set ONLY when the truncated walk actually won the
 * merge. A truncated walk that lost to an older exact metadata date tells us
 * nothing and must not taint the result.
 */
export function canonicalAge(
  base: AgeBaseline,
  sig: CreationSlotResult | null | undefined
): CanonicalAge {
  let { createdAtMs, slot, timeSource } = base;
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

  return { createdAtMs, slot, timeSource, createdAtIsLowerBound };
}

/** Write a recomputed canonical age onto a token (in place). */
function applyCanonicalAge(token: TokenResult, age: CanonicalAge): void {
  token.createdAtMs = age.createdAtMs;
  token.createdAt = age.createdAtMs
    ? new Date(age.createdAtMs).toISOString()
    : null;
  token.slot = age.slot;
  token.timeSource = age.timeSource;
  if (age.createdAtIsLowerBound) token.createdAtIsLowerBound = true;
  else delete token.createdAtIsLowerBound;
}

/** What the deep phase decided to do, so callers can report it. */
export interface AgeEscalationReport {
  /** Mints escalated to a deep walk, in the order they were chosen. */
  targets: string[];
  /** Tokens whose truncation could change the #1 answer (before the cap). */
  ambiguousTotal: number;
  /** Ambiguous tokens the cap left unresolved — MUST be surfaced, not swallowed. */
  droppedByCap: number;
  /** Deep walks that reached the beginning and produced an exact date. */
  resolved: number;
  /** Deep walks that were STILL truncated (budget/deadline) — progress persisted. */
  stillTruncated: number;
  /** Wall-clock the phase actually spent, against DEEP_PHASE_BUDGET_MS. */
  elapsedMs: number;
}

/** Ranking weight for the escalation cap: real tokens outbid dust. */
function escalationPriority(t: TokenResult): number {
  const liq = typeof t.liquidityUsd === "number" ? t.liquidityUsd : 0;
  const mc =
    typeof t.marketCapUsd === "number"
      ? t.marketCapUsd
      : typeof t.fdvUsd === "number"
        ? t.fdvUsd
        : 0;
  return Math.max(liq, mc);
}

/**
 * Which tokens get the DEEP signature budget.
 *
 * A truncated token X carries "true creation <= t_X, by an unknown amount".
 * Against the current leader L at t_L:
 *   t_X < t_L  → X already sorts above L; it IS older, its exact date aside.
 *   t_X > t_L  → UNKNOWABLE. X may predate L by years. This is the reported bug.
 * So the ambiguous set is exactly the truncated tokens ranked BELOW the leader,
 * and resolving them is what makes the #1 answer provable — minus the
 * relatedOnly ones, which cannot take the crown at any age and therefore
 * cannot make it any more (or less) provable.
 *
 * Always included (when their age is still a lower bound — an exact date has
 * nothing to resolve): the scanned mint and the current rank 1.
 *
 * @param tokens sorted oldest-first
 */
export function selectAgeEscalationTargets(
  tokens: TokenResult[],
  scannedMint?: string,
  cap: number = MAX_DEEP_ESCALATIONS
): { targets: string[]; ambiguousTotal: number; droppedByCap: number } {
  const unresolved = (t: TokenResult | undefined): t is TokenResult =>
    t != null && t.createdAtIsLowerBound === true;

  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (t: TokenResult | undefined) => {
    if (!unresolved(t) || seen.has(t.mint)) return;
    seen.add(t.mint);
    targets.push(t.mint);
  };

  // Always: the token wearing (or about to wear) the crown, and the mint the
  // user actually asked about.
  add(tokens[0]);
  if (scannedMint) add(tokens.find((t) => t.mint === scannedMint));

  const leaderMs = tokens.find((t) => t.createdAtMs != null)?.createdAtMs;

  const ambiguous = tokens.filter(
    (t) =>
      t.createdAtIsLowerBound === true &&
      !seen.has(t.mint) &&
      // A derivative name cannot take the crown at any age (sort.ts), so
      // resolving it cannot make the #1 answer provable — and the budget it
      // would spend belongs to a token that CAN change the verdict.
      t.relatedOnly !== true &&
      leaderMs != null &&
      t.createdAtMs != null &&
      t.createdAtMs > leaderMs
  );

  const ranked = [...ambiguous].sort(
    (a, b) => escalationPriority(b) - escalationPriority(a)
  );
  const room = Math.max(0, cap);
  for (const t of ranked.slice(0, room)) {
    seen.add(t.mint);
    targets.push(t.mint);
  }

  return {
    targets,
    ambiguousTotal: ambiguous.length,
    droppedByCap: Math.max(0, ambiguous.length - room),
  };
}

/**
 * Deep-resolve the age-critical tokens, then recompute their canonical times.
 * Bounded three ways: at most 2 + MAX_DEEP_ESCALATIONS tokens, DEEP_SIG_PAGES
 * pages each, and DEEP_PHASE_BUDGET_MS wall-clock across the whole phase.
 * Every failure leaves the token's existing (lower-bound) age untouched.
 *
 * @param tokens sorted oldest-first; mutated in place. Caller must re-sort.
 */
async function deepResolveAges(
  tokens: TokenResult[],
  baselines: Map<string, AgeBaseline>,
  scannedMint: string | undefined
): Promise<AgeEscalationReport> {
  const { targets, ambiguousTotal, droppedByCap } = selectAgeEscalationTargets(
    tokens,
    scannedMint
  );
  const startedAt = Date.now();
  const report: AgeEscalationReport = {
    targets,
    ambiguousTotal,
    droppedByCap,
    resolved: 0,
    stillTruncated: 0,
    elapsedMs: 0,
  };
  if (targets.length === 0) return report;

  const deadlineMs = startedAt + DEEP_PHASE_BUDGET_MS;
  const byMint = new Map(tokens.map((t) => [t.mint, t]));

  for (let i = 0; i < targets.length; i += CREATION_SLOT_CONCURRENCY) {
    const chunk = targets.slice(i, i + CREATION_SLOT_CONCURRENCY);
    const found = await Promise.all(
      chunk.map((mint) =>
        getCreationSlot(mint, { maxPages: DEEP_SIG_PAGES, deadlineMs }).catch(
          () => null
        )
      )
    );
    for (let j = 0; j < chunk.length; j++) {
      const sig = found[j];
      const token = byMint.get(chunk[j]);
      if (!token || !sig) continue;
      const base = baselines.get(chunk[j]);
      if (!base) continue;
      applyCanonicalAge(token, canonicalAge(base, sig));
      if (sig.truncated) report.stillTruncated++;
      else report.resolved++;
    }
  }

  report.elapsedMs = Date.now() - startedAt;
  return report;
}

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
    /** Called with what the deep age-resolution phase did (creation ranking, full pass only). */
    onAgeEscalation?: (report: AgeEscalationReport) => void;
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
  /**
   * Metadata-only creation times, kept so the deep phase can recompute the
   * canonical merge from scratch instead of layering onto a derived value.
   */
  const baselines = new Map<string, AgeBaseline>();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const sig = sigResults[i];
    const base: AgeBaseline = {
      createdAtMs: c.createdAtMs,
      slot: c.slot,
      timeSource: c.timeSource,
    };
    baselines.set(c.raw.mint, base);
    const { createdAtMs, slot, timeSource, createdAtIsLowerBound } =
      canonicalAge(base, sig);

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

    // DERIVATIVE NAME? Decided here, on the DISPLAYED identity — the name the
    // user actually reads, resolved across three sources — and against the
    // query this cohort is being scored for, which is why it is computed at
    // this point rather than carried on RawToken.
    //
    // The SCANNED MINT is never derivative: the query was derived from its own
    // name/symbol, so it is by definition contesting it (and a long name gets
    // truncated to MAX_QUERY on the way into the search, which would otherwise
    // make a token fail to match itself).
    //
    // Creation ranking only. A social/market-cap leaderboard is queried by URL,
    // makes no claim about a name, and must not sprout "related" flags.
    const relatedOnly =
      rankBy === "creation" &&
      !c.isScannedMint &&
      !isCrownEligible(
        tokenMatchTier(displayName, displaySymbol, queryForScore)
      );

    const image = resolveTokenImage(c.raw.imageUrl, c.h?.imageUrl);

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
      imageUrl: image?.imageUrl ?? null,
      ...(image ? { imageSource: image.imageSource } : {}),
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
      ...(relatedOnly ? { relatedOnly: true as const } : {}),
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
      // On-chain metadata that rode along on the SAME getAssetBatch response —
      // no extra request per cohort token. Absent = DAS did not report it.
      ...(c.h?.description ? { description: c.h.description } : {}),
      ...(c.h?.tokenStandard ? { tokenStandard: c.h.tokenStandard } : {}),
      ...(typeof c.h?.decimals === "number" ? { decimals: c.h.decimals } : {}),
      ...(c.h?.supply != null ? { supplyAmount: c.h.supply } : {}),
      ...(c.h?.updateAuthority
        ? { updateAuthority: c.h.updateAuthority }
        : {}),
      ...(c.h?.burnt !== undefined ? { burnt: c.h.burnt } : {}),
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

  let sorted = sortByCreationTime(enriched);

  // Age is the whole answer in creation mode, so the tokens whose truncated
  // walk could change the #1 answer get a deep, resumable budget here — never
  // in the fast phase, which must stay fast and keeps pendingAge semantics.
  if (!skipSignatureScan) {
    const report = await deepResolveAges(
      sorted,
      baselines,
      options?.scannedMint
    );
    if (report.droppedByCap > 0) {
      // Silent capping is how the original bug survived — always say it.
      console.warn(
        `[OGfinder] age escalation capped: ${report.droppedByCap} of ` +
          `${report.ambiguousTotal} ambiguous token(s) left unresolved ` +
          `(query="${queryForScore}")`
      );
    }
    options?.onAgeEscalation?.(report);
    // Deep walks can move a token years earlier — the order is stale now.
    sorted = sortByCreationTime(sorted);
  }

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
