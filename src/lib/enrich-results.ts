import { RawToken, TokenResult, MAX_RESULTS } from "./types";
import { getAssetBatch, getCreationSlot } from "./helius";
import {
  sortByCreationTime,
  scoreConfidence,
  resolveDisplayName,
  resolveDisplaySymbol,
} from "./sort";

export async function buildTokenResults(
  rawTokens: RawToken[],
  queryForScore: string,
  options?: { scannedMint?: string }
): Promise<TokenResult[]> {
  const mints = rawTokens.map((t) => t.mint);
  const heliusData = await getAssetBatch(mints);

  const enriched: TokenResult[] = [];

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

    if (raw.pairCreatedAt) {
      if (createdAtMs == null || raw.pairCreatedAt < createdAtMs) {
        createdAtMs = raw.pairCreatedAt;
        timeSource = "dexscreener";
      }
    }

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
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      dexId: raw.dexId ?? null,
      confidence: 0,
      confidenceLabel: "",
      rank: 0,
      rankLabel: "",
      timeSource,
      ...(isScannedMint ? { isScanned: true } : {}),
    });
  }

  const sorted = sortByCreationTime(enriched);
  const scored = scoreConfidence(sorted, queryForScore);
  return scored.slice(0, MAX_RESULTS);
}
