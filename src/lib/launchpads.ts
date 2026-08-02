/** Bucket ids used for multi-select filters (aligned with DexScreener `dexId` where curated). */
export const LAUNCHPAD_BUCKETS: { id: string; label: string }[] = [
  { id: "pumpfun", label: "Pump.fun" },
  { id: "letsbonk", label: "LetsBonk" },
  { id: "pumpswap", label: "PumpSwap" },
  { id: "raydium", label: "Raydium" },
  { id: "launchlab", label: "LaunchLab" },
  { id: "moonshot", label: "Moonshot" },
  { id: "boop", label: "Boop" },
  { id: "believe", label: "Believe" },
  { id: "meteora", label: "Meteora" },
  { id: "orca", label: "Orca" },
  { id: "unknown", label: "No DEX / Jupiter only" },
  { id: "other", label: "Other" },
];

/**
 * DexScreener `dexId` → curated bucket. Variants observed live (meteoradbc,
 * launchlab) and known aliases collapse into one bucket per venue.
 */
const DEX_ID_TO_BUCKET: Record<string, string> = {
  pumpfun: "pumpfun",
  pumpswap: "pumpswap",
  raydium: "raydium",
  launchlab: "launchlab", // Raydium LaunchLab (letsbonk.fun launches here)
  moonshot: "moonshot",
  moonit: "moonshot", // Moonshot rebrand
  boop: "boop",
  boopfun: "boop", // boop.fun
  believe: "believe",
  meteora: "meteora",
  meteoradbc: "meteora", // Meteora Dynamic Bonding Curve
  "meteora-dlmm": "meteora",
  orca: "orca",
  "orca-whirlpool": "orca",
  whirlpool: "orca",
};

export function bucketForDexId(dexId: string | null): string {
  if (dexId == null || dexId === "") return "unknown";
  return DEX_ID_TO_BUCKET[dexId] ?? "other";
}

/**
 * Buckets where the dexId only tells us the CURRENT/migration venue (or
 * nothing), so a vanity-suffix launch signal may override it.
 * launchlab is included because letsbonk.fun is a branded LaunchLab frontend.
 */
const VANITY_OVERRIDABLE = new Set([
  "unknown",
  "other",
  "raydium",
  "pumpswap",
  "launchlab",
]);

/**
 * SECONDARY signal: launchpad inferred from the mint's vanity suffix —
 * pump.fun grinds mints ending in "pump", letsbonk.fun in "bonk".
 * Returns null when the suffix is not a known launchpad marker.
 */
export function bucketForMintSuffix(mint: string): string | null {
  if (mint.endsWith("pump")) return "pumpfun";
  if (mint.endsWith("bonk")) return "letsbonk";
  return null;
}

/**
 * Combined bucket for a token: dexId first; when the dexId bucket only
 * reflects a migration venue, the mint vanity suffix wins (launch venue
 * beats migration venue).
 */
export function bucketForToken(dexId: string | null, mint: string): string {
  const byDex = bucketForDexId(dexId);
  if (VANITY_OVERRIDABLE.has(byDex)) {
    const bySuffix = bucketForMintSuffix(mint);
    if (bySuffix) return bySuffix;
  }
  return byDex;
}

export function labelForBucket(bucketId: string): string {
  const found = LAUNCHPAD_BUCKETS.find((b) => b.id === bucketId);
  return found?.label ?? bucketId;
}
