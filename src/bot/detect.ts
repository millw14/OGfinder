/**
 * Solana CA detection in free-form chat text.
 *
 * Stricter than the site's isLikelyMintAddress: candidates must base58-decode
 * to exactly 32 bytes, and well-known program/system addresses are skipped so
 * pasted tx logs don't trigger junk scans. Also extracts mints out of common
 * trading-site URLs (pump.fun, solscan, birdeye, gmgn, jup.ag, …) and flags
 * DexScreener/Photon PAIR addresses for API resolution to the base mint.
 */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map<string, number>(
  [...B58_ALPHABET].map((c, i) => [c, i])
);

/** base58 → bytes, null on invalid chars. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let value = 0n;
  for (const c of s) {
    const d = B58_MAP.get(c);
    if (d === undefined) return null;
    value = value * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** True for a string that decodes to a 32-byte Solana public key. */
export function isValidSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  const decoded = base58Decode(s);
  return decoded !== null && decoded.length === 32;
}

/** Well-known non-mint accounts that show up in pasted text/logs. */
const KNOWN_NON_MINTS = new Set<string>([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token
  "ComputeBudget111111111111111111111111111111",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex Metadata
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
]);

export interface DetectedAddresses {
  /** Candidate token mints, ready to scan. */
  mints: string[];
  /** DexScreener/Photon pair (pool) addresses — resolve to base mint first. */
  pairAddresses: string[];
}

const RAW_B58_RUN =
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Max distinct addresses processed per message. */
export const MAX_ADDRESSES_PER_MESSAGE = 3;

interface UrlExtraction {
  mint?: string;
  pair?: string;
}

/** Extract a mint or pair address out of one known trading-site URL. */
function extractFromUrl(raw: string): UrlExtraction | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";

  const valid = (s: string) => isValidSolanaAddress(s);

  // pump.fun/coin/<mint> or pump.fun/<mint>
  if (host === "pump.fun" && valid(last)) return { mint: last };

  // solscan.io/token/<mint>, solscan.io/account/<addr>
  if (host === "solscan.io" && segs[0] === "token" && valid(last)) {
    return { mint: last };
  }

  // birdeye.so/token/<mint>?chain=solana
  if (host === "birdeye.so" && segs[0] === "token" && valid(last)) {
    return { mint: last };
  }

  // gmgn.ai/sol/token/<mint> (sometimes <tag>_<mint>)
  if (host === "gmgn.ai" && segs.includes("token")) {
    const cand = last.includes("_") ? last.split("_").pop() ?? "" : last;
    if (valid(cand)) return { mint: cand };
  }

  // jup.ag/swap/SOL-<mint> or /tokens/<mint>
  if (host === "jup.ag") {
    if (segs[0] === "tokens" && valid(last)) return { mint: last };
    const dash = last.split("-").pop() ?? "";
    if (valid(dash)) return { mint: dash };
  }

  // dexscreener.com/solana/<pairAddress> — pair, must be resolved.
  if (host === "dexscreener.com" && segs[0] === "solana" && valid(last)) {
    return { pair: last };
  }

  // photon-sol.tinyastro.io/en/lp/<pairAddress>
  if (host.endsWith("tinyastro.io") && segs.includes("lp") && valid(last)) {
    return { pair: last };
  }

  // neo.bullx.io/terminal?address=<mint>
  if (host.endsWith("bullx.io")) {
    const addr = u.searchParams.get("address") ?? "";
    if (valid(addr)) return { mint: addr };
  }

  return null;
}

/**
 * Find scannable Solana addresses in a chat message.
 * URLs are parsed first; raw base58 runs are validated by decoding.
 */
export function detectAddresses(text: string): DetectedAddresses {
  const mints: string[] = [];
  const pairs: string[] = [];
  const seen = new Set<string>();
  /** Addresses that appeared inside a pair-URL — don't also scan them raw. */
  const pairSeen = new Set<string>();

  const add = (mint: string) => {
    if (seen.has(mint) || pairSeen.has(mint)) return;
    if (KNOWN_NON_MINTS.has(mint)) return;
    seen.add(mint);
    mints.push(mint);
  };

  for (const rawUrl of text.match(URL_RE) ?? []) {
    const found = extractFromUrl(rawUrl);
    if (!found) continue;
    if (found.pair && !pairSeen.has(found.pair)) {
      pairSeen.add(found.pair);
      pairs.push(found.pair);
    }
    if (found.mint) add(found.mint);
  }

  for (const cand of text.match(RAW_B58_RUN) ?? []) {
    if (!isValidSolanaAddress(cand)) continue;
    add(cand);
  }

  return {
    mints: mints.slice(0, MAX_ADDRESSES_PER_MESSAGE),
    pairAddresses: pairs.slice(0, MAX_ADDRESSES_PER_MESSAGE),
  };
}
