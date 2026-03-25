/** Bucket ids used for multi-select filters (aligned with DexScreener `dexId` where curated). */
export const LAUNCHPAD_BUCKETS: { id: string; label: string }[] = [
  { id: "pumpfun", label: "Pump.fun" },
  { id: "pumpswap", label: "PumpSwap" },
  { id: "raydium", label: "Raydium" },
  { id: "meteora", label: "Meteora" },
  { id: "orca", label: "Orca" },
  { id: "unknown", label: "No DEX / Jupiter only" },
  { id: "other", label: "Other" },
];

const CURATED_DEX_IDS = new Set([
  "pumpfun",
  "pumpswap",
  "raydium",
  "meteora",
  "orca",
]);

export function bucketForDexId(dexId: string | null): string {
  if (dexId == null || dexId === "") return "unknown";
  if (CURATED_DEX_IDS.has(dexId)) return dexId;
  return "other";
}

export function labelForBucket(bucketId: string): string {
  const found = LAUNCHPAD_BUCKETS.find((b) => b.id === bucketId);
  return found?.label ?? bucketId;
}
