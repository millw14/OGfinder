/** Base58 Solana address: typically 32–44 chars, no 0 O I l */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isLikelyMintAddress(s: string): boolean {
  const t = s.trim();
  if (t.length < 32 || t.length > 44) return false;
  return BASE58.test(t);
}
