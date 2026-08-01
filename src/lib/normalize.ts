export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** DexScreener pairCreatedAt is ms; if mis-serialized as Unix seconds, normalize to ms. */
export function dexPairCreatedMs(t: number | undefined): number | undefined {
  if (t == null || !Number.isFinite(t)) return undefined;
  if (t > 0 && t < 1e12) return Math.round(t * 1000);
  return t;
}
