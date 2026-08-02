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
  /** DexScreener token logo (info.imageUrl), from the highest-liquidity pair */
  imageUrl?: string;
  /** DexScreener price (USD), from the highest-liquidity pair */
  priceUsd?: number;
  /** DexScreener liquidity (USD), from the highest-liquidity pair */
  liquidityUsd?: number;
  /** DexScreener 24h price change (%), from the highest-liquidity pair */
  priceChange24h?: number;
}

export interface HeliusSlotData {
  slot: number | null;
  createdAt: string | null;
  heliusName: string | null;
  heliusSymbol: string | null;
  tokenInterface: string | null;
  supply: number | null;
  /** DAS token_info.mint_authority present — supply can be inflated. Absent = unknown. */
  mintAuthorityActive?: boolean;
  /** DAS token_info.freeze_authority present — accounts can be frozen. Absent = unknown. */
  freezeAuthorityActive?: boolean;
  /** DAS top-level `mutable` — metadata (name/image) can still change. Absent = unknown. */
  metadataMutable?: boolean;
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
  /** DexScreener token logo URL, when present */
  imageUrl?: string | null;
  /** DexScreener price (USD), from the highest-liquidity pair */
  priceUsd?: number | null;
  /** DexScreener liquidity (USD), from the highest-liquidity pair */
  liquidityUsd?: number | null;
  /** DexScreener 24h price change (%) */
  priceChange24h?: number | null;
  /** How list order was determined (OG vs volume leaderboard) */
  rankingMode?: "creation" | "volume" | "marketcap";
  /** Fast phase only: no creation time yet — signature scan still pending */
  pendingAge?: true;
  /** Name+symbol exactly match the search query (informational — no OG implication) */
  exactMatch?: true;
  /** Name/symbol matches the query only via lookalike folding (Cyrillic/Greek
   *  homoglyphs, invisible chars) — likely impersonation. Omitted when clean. */
  homoglyphSuspect?: true;
  /** True = mint authority active (supply inflatable); false = revoked; absent = unknown */
  mintAuthorityActive?: boolean;
  /** True = freeze authority active (accounts freezable); false = revoked; absent = unknown */
  freezeAuthorityActive?: boolean;
  /** True = metadata mutable (name/image can change); false = immutable; absent = unknown */
  metadataMutable?: boolean;
  /**
   * Earliest-claim evidence for a contested social/website link. firstSeenMs
   * is when OGFINDER'S link index first observed this mint claiming the URL —
   * NOT when the link was created or first posted. The index only covers
   * recently listed tokens, so absence of this field proves nothing.
   */
  linkProvenance?: {
    /** Normalized claimed URL — render as plain text, never as an href */
    url: string;
    /** When our index first saw this mint claim the URL (ms) */
    firstSeenMs: number;
    /** Other indexed tokens claiming the same URL */
    rivalCount: number;
    /** Head start over the next-earliest claimant (ms) */
    leadMs: number;
  };
  /**
   * Scan mode, scanned + OG mints only: % of supply held by the 10 largest
   * token accounts. Includes LP pools and burn addresses — an UPPER BOUND on
   * wallet concentration.
   */
  topHolderPct?: number;
}

/** One side of an OG-flip verdict (values are from the newer snapshot). */
export interface FlipParty {
  mint: string;
  name: string;
  value: number;
}

/**
 * Leaderboard flip between the two most recent query snapshots. The OG is the
 * older snapshot's rank-1 (oldest) token; the challenger is the top non-OG
 * token by the selected metric. The metric is only chosen when BOTH sides
 * carry it in BOTH snapshots — market cap and liquidity are never mixed.
 */
export interface FlipInfo {
  /** True: the challenger currently leads the OG on the metric. */
  flipped: boolean;
  /** Set when the OG regained the lead it had lost in the older snapshot. */
  reclaimed?: true;
  /** taken_at of the newer snapshot (ms). */
  at: number;
  metric: "marketcap" | "liquidity";
  og: FlipParty;
  challenger: FlipParty;
}

/** Snapshot history for a text search, attached to text-mode responses. */
export interface SearchHistory {
  snapshotCount: number;
  firstSnapshotAt: number;
  flip: FlipInfo | null;
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
  /** Present on fast-phase responses (signature scans skipped) */
  phase?: "fast";
  /** True when a follow-up full request will deliver verified on-chain ages */
  enriching?: boolean;
  /** Scan fast phase: verdict computed without signature scans — not final */
  verdictPreliminary?: boolean;
  /** Providers that failed during this request — results may be incomplete */
  degraded?: string[];
  /** Text mode only: leaderboard snapshot history + OG-flip verdict */
  history?: SearchHistory | null;
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
  | "verdictPreliminary"
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
  /** Signature of the oldest analyzed transaction */
  oldestSig?: string | null;
  /** Win/loss record over tokens with sells; win = realizedPnlSol > 0 */
  winRate?: { wins: number; losses: number; pct: number };
  /** True when older history exists and a deep-scan cursor is available */
  canDeepen?: boolean;
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
  /** Token quantity bought/sold in UI units (0 = quantity unknown) */
  qtyBought: number;
  qtySold: number;
  /** Weighted-average cost in SOL per token; null when quantities unknown */
  avgCostSol: number | null;
  /** Quantity still held per the analyzed window (bought - sold, floored at 0) */
  remainingQty: number;
  /** Cost basis of the remaining quantity, in SOL */
  remainingBasisSol: number;
  /** Includes USDC/USDT-quoted swaps valued at the current SOL price */
  approxUsd?: true;
  /** Sold more than bought in the analyzed window — cost basis incomplete */
  basisIncomplete?: true;
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
