export interface RawToken {
  mint: string;
  dexName?: string;
  dexSymbol?: string;
  jupName?: string;
  jupSymbol?: string;
  dexId?: string;
  pairCreatedAt?: number; // ms timestamp from DexScreener
  /** DexScreener 24h volume (USD) when from social / pair search */
  volumeUsd24h?: number;
  /** DexScreener pair market cap (USD), when present */
  dexMarketCapUsd?: number;
  /** DexScreener FDV (USD), when market cap is missing */
  dexFdvUsd?: number;
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
  /** True when the signature scan was truncated — real creation may be older */
  createdAtIsLowerBound?: boolean;
  /** True when on-chain supply is zero (fully burned) */
  supplyZero?: boolean;
  /** True when this mint was pasted for a CA scan */
  isScanned?: boolean;
  /** Present for social-link search: 24h volume from DexScreener */
  volumeUsd24h?: number | null;
  /** Social-link search: DexScreener market cap (USD) */
  marketCapUsd?: number | null;
  /** Social-link search: DexScreener FDV when MC missing */
  fdvUsd?: number | null;
  /** How list order was determined (OG vs volume leaderboard) */
  rankingMode?: "creation" | "volume" | "marketcap";
}

export interface SearchResponse {
  results: TokenResult[];
  query: string;
  totalFound: number;
  timing?: number;
  mode?: "search" | "scan" | "social";
  scannedMint?: string;
  scanName?: string | null;
  scanSymbol?: string | null;
  isScannedOG?: boolean;
  scannedRank?: number | null;
  /** Raw user input (e.g. mint when scanning) */
  originalInput?: string;
  error?: string;
}

/** Scan-mode summary the client keeps from a SearchResponse (server verdict is authoritative). */
export type ScanSummary = Pick<
  SearchResponse,
  | "mode"
  | "isScannedOG"
  | "scannedRank"
  | "scanName"
  | "scanSymbol"
  | "scannedMint"
>;

/** Merged name-search cap: each mint runs Helius getAssetBatch + getCreationSlot (linear cost). */
export const MAX_HELIUS = 240;
export const MAX_RESULTS = 100;
/** DexScreener search: max unique base mints after oldest-pool sort. */
export const DEX_LIMIT = 120;
/** Jupiter search matches after relevance sort (Token API v2 returns ≤100/query). */
export const JUP_LIMIT = 280;
export const MIN_QUERY = 2;
export const MAX_QUERY = 30;
/** Max length for pasted Solana mint (base58) */
export const MAX_MINT_LEN = 44;
/** Pasted social / website URLs for DexScreener link search */
export const MAX_SOCIAL_URL = 512;
export const CACHE_SEARCH = 600;
export const CACHE_DEX = 300;
export const CACHE_JUP = 3600;
export const CACHE_HELIUS = 3600;
export const DEX_TIMEOUT = 5000;
export const HELIUS_TIMEOUT = 10000;
export const MAX_SIG_PAGES = 5;

export const CACHE_WALLET = 300;
export const WALLET_TX_PAGES = 5;
export const WALLET_TX_PER_PAGE = 100;

export interface WalletAnalysis {
  address: string;
  totalPnlSol: number;
  totalPnlUsd: number | null;
  topCoin: {
    mint: string;
    name: string;
    symbol: string;
    pnlSol: number;
  } | null;
  avgHoldTimeMs: number;
  holdings: WalletHolding[];
  tokenPnl: TokenPnlEntry[];
  sideWallets: SideWallet[];
  txCount: number;
  /** Wallet's native SOL balance in lamports, when available */
  solBalanceLamports?: number;
  /** True when an upstream holdings/tx fetch failed — data may be incomplete */
  partial?: boolean;
  /** True when the tx window hit WALLET_TX_PAGES with more history remaining */
  truncated?: boolean;
  /** Timestamp (ms) of the oldest analyzed transaction */
  oldestTxMs?: number | null;
  timing: number;
}

export interface WalletHolding {
  mint: string;
  name: string;
  symbol: string;
  amount: number;
  decimals: number;
  valueUsd: number | null;
}

export interface TokenPnlEntry {
  mint: string;
  name: string;
  symbol: string;
  totalBoughtSol: number;
  totalSoldSol: number;
  realizedPnlSol: number;
  currentValueSol: number;
  unrealizedPnlSol: number;
  firstBuyMs: number;
  lastActivityMs: number;
  holdTimeMs: number;
}

export interface SideWallet {
  address: string;
  interactionCount: number;
  totalSolTransferred: number;
  direction: "sent" | "received" | "both";
}

export interface WalletResponse {
  data?: WalletAnalysis;
  error?: string;
}
