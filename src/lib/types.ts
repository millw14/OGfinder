export interface RawToken {
  mint: string;
  dexName?: string;
  dexSymbol?: string;
  jupName?: string;
  jupSymbol?: string;
  dexId?: string;
  pairCreatedAt?: number; // ms timestamp from DexScreener
}

export interface HeliusSlotData {
  slot: number | null;
  createdAt: string | null;
  heliusName: string | null;
  heliusSymbol: string | null;
  tokenInterface: string | null;
  supply: number | null;
}

export interface TokenResult {
  mint: string;
  displayName: string;
  displaySymbol: string;
  slot: number | null;
  createdAtMs: number | null; // canonical creation time in ms (used for sorting)
  createdAt: string | null;
  dexId: string | null;
  confidence: number;
  confidenceLabel: string;
  rank: number;
  rankLabel: string;
  timeSource: string; // where we got creation time from
  /** True when this mint was pasted for a CA scan */
  isScanned?: boolean;
}

export interface SearchResponse {
  results: TokenResult[];
  query: string;
  totalFound: number;
  timing?: number;
  mode?: "search" | "scan";
  scannedMint?: string;
  scanName?: string | null;
  scanSymbol?: string | null;
  isScannedOG?: boolean;
  scannedRank?: number | null;
  /** Raw user input (e.g. mint when scanning) */
  originalInput?: string;
  error?: string;
}

export const MAX_HELIUS = 150;
export const MAX_RESULTS = 100;
export const DEX_LIMIT = 100;
export const JUP_LIMIT = 200;
export const MIN_QUERY = 2;
export const MAX_QUERY = 30;
/** Max length for pasted Solana mint (base58) */
export const MAX_MINT_LEN = 44;
export const CACHE_SEARCH = 600;
export const CACHE_DEX = 300;
export const CACHE_JUP = 3600;
export const CACHE_HELIUS = 3600;
export const DEX_TIMEOUT = 5000;
export const HELIUS_TIMEOUT = 10000;
export const MAX_SIG_PAGES = 5;
