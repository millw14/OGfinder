import {
  RawToken,
  TokenResult,
  MAX_RESULTS,
  HeliusSlotData,
} from "./types";
import { getAssetBatch, getCreationSlot } from "./helius";
import { dexPairCreatedMs } from "./normalize";
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

export async function buildTokenResults(
  rawTokens: RawToken[],
  queryForScore: string,
  options?: {
    scannedMint?: string;
    /** Default: oldest-first (OG). Social: use marketcap (MC → vol → age). */
    rankBy?: "creation" | "volume" | "marketcap";
  }
): Promise<TokenResult[]> {
  const rankBy = options?.rankBy ?? "creation";
  const mints = rawTokens.map((t) => t.mint);
  const heliusData = await getAssetBatch(mints);

  type Candidate = {
    raw: RawToken;
    h: HeliusSlotData | undefined;
    isScannedMint: boolean;
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
      if (h.supply != null && h.supply <= 0 && !isScannedMint) {
        continue;
      }
    }

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

    candidates.push({ raw, h, isScannedMint, createdAtMs, slot, timeSource });
  }

  const sigResults: Awaited<ReturnType<typeof getCreationSlot>>[] = [];
  for (let i = 0; i < candidates.length; i += CREATION_SLOT_CONCURRENCY) {
    const chunk = candidates.slice(i, i + CREATION_SLOT_CONCURRENCY);
    const part = await Promise.all(
      chunk.map((c) => getCreationSlot(c.raw.mint))
    );
    sigResults.push(...part);
  }

  const enriched: TokenResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const sig = sigResults[i];
    let { createdAtMs, slot, timeSource } = c;

    if (sig) {
      const sigMs = sig.blockTime * 1000;
      if (createdAtMs == null || sigMs < createdAtMs) {
        createdAtMs = sigMs;
        slot = sig.slot;
        timeSource = "signatures";
      }
    }

    enriched.push({
      mint: c.raw.mint,
      displayName: resolveDisplayName(
        c.raw.dexName,
        c.raw.jupName,
        c.h?.heliusName
      ),
      displaySymbol: resolveDisplaySymbol(
        c.raw.dexSymbol,
        c.raw.jupSymbol,
        c.h?.heliusSymbol
      ),
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
      rankingMode:
        rankBy === "marketcap"
          ? "marketcap"
          : rankBy === "volume"
            ? "volume"
            : "creation",
      ...(c.isScannedMint ? { isScanned: true } : {}),
    });
  }

  if (rankBy === "volume") {
    const sorted = sortByVolumeUsd(enriched);
    const scored = scoreVolumeRank(sorted);
    return scored.slice(0, MAX_RESULTS);
  }

  if (rankBy === "marketcap") {
    const sorted = sortByMarketCapLeaderboard(enriched);
    const scored = scoreMarketCapRank(sorted);
    return scored.slice(0, MAX_RESULTS);
  }

  const sorted = sortByCreationTime(enriched);
  const scored = scoreConfidence(sorted, queryForScore);
  return scored.slice(0, MAX_RESULTS);
}
