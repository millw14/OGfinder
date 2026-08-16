// Type-only import (fully erased at build time), so the value-level dependency
// stays one-way: safety.ts imports the thresholds below, never the reverse.
import type { SafetyLevel, SafetyFlagCode } from "./safety";

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
  /**
   * DexScreener txns.h24 buy/sell counts from the SAME pair the market data
   * comes from (highest liquidity). "Buys but no sells" is the strongest
   * empirical honeypot tell we can get for free.
   */
  buys24h?: number;
  sells24h?: number;
  /** txns.h6 counts — corroborates the 24h picture on fast-moving launches. */
  buys6h?: number;
  sells6h?: number;
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
  // ————— Media + metadata that ride along on the SAME getAssetBatch call —————
  /**
   * Token image from DAS content, http/https only (see isSafeImageUrl). Prefers
   * the Helius CDN copy, which is resized AND proxied — so a visitor's browser
   * never hits whatever arbitrary host the mint's metadata names.
   */
  imageUrl?: string;
  /** DAS content.metadata.description — the on-chain project blurb. */
  description?: string;
  /** DAS content.metadata.token_standard, e.g. "Fungible" / "FungibleAsset". */
  tokenStandard?: string;
  /** DAS token_info.decimals — needed to render supply as a human number. */
  decimals?: number;
  /** DAS authorities[] entry holding scope "full" — who can rewrite the metadata. */
  updateAuthority?: string;
  /** DAS top-level `burnt`. Absent = unknown, never assume false. */
  burnt?: boolean;
  /** DAS content.json_uri — the off-chain metadata JSON (http/https only). */
  jsonUri?: string;
}

/**
 * Socials + description from a mint's off-chain metadata JSON (content.json_uri).
 *
 * Field names verified empirically 2026-08-11 over 53 reachable json_uri docs
 * from live Solana pairs: top-level `website` (4), `twitter` (7), `telegram` (3),
 * with the same names also appearing under `extensions` (34 docs carry an
 * `extensions` object). 12 of 53 carried at least one social — sparse, but real,
 * and free for the one mint the user actually asked about.
 *
 * Every URL here is attacker-controlled and http/https-validated on the way in.
 */
export interface TokenSocials {
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface OffchainTokenMeta extends TokenSocials {
  description?: string;
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
  /**
   * RANK 1 ONLY: the ordering behind this #1 is NOT proven — a token ranked
   * below it still carries a lower-bound age that could predate it (or this
   * token's own age is a bound / pending). Set by scoreConfidence, which also
   * withholds the OG label; absent means the #1 answer holds against every
   * token we ranked. Never set on ranks 2+.
   */
  ageOrderUnproven?: true;
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
  /**
   * Token logo. DexScreener's curated market logo when it has one, else the
   * on-chain DAS image — see resolveTokenImage. Always http/https (validated),
   * so it is safe to hand straight to an <img src>.
   */
  imageUrl?: string | null;
  /** Which source imageUrl came from. Absent when there is no logo at all. */
  imageSource?: "dexscreener" | "das";
  /** On-chain metadata description. Absent = the token doesn't publish one. */
  description?: string;
  /** Metaplex token standard from DAS, e.g. "Fungible". */
  tokenStandard?: string;
  /** Mint decimals — supplyAmount is in raw units, divide by 10**decimals. */
  decimals?: number;
  /** Raw on-chain supply (NOT decimal-adjusted). Absent = not reported. */
  supplyAmount?: number;
  /** Wallet holding metadata update authority (DAS scope "full"). */
  updateAuthority?: string;
  /** DAS top-level `burnt`. Absent = unknown. */
  burnt?: boolean;
  /**
   * Scanned mint only: socials parsed from the off-chain metadata JSON. Each
   * URL is a CLAIM BY THE TOKEN, not a verified affiliation — render with the
   * same suspicion as any other user-supplied link.
   */
  socials?: TokenSocials;
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
  /**
   * DERIVATIVE NAME — interesting to see, never a contender for the name.
   *
   * The query only appears inside this token's name/symbol as a bare substring
   * ("bonk" in "BONKMONEY", "karat" in "Karate Cat"), or the displayed identity
   * does not carry the query at all — see isCrownEligible in match.ts. Such a
   * token is shown, but it sorts BELOW the whole real cohort (sortByCreationTime),
   * earns no OG label however old it is (scoreConfidence), cannot block the #1
   * answer (ageOrderConfidence) and is never written to the OG registry.
   *
   * Creation ranking only, and NEVER set on the scanned mint — the query was
   * derived from that mint's own name, so it always contests it.
   */
  relatedOnly?: true;
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
  /**
   * Scan mode, scanned mint only: wallet that paid for the mint's very first
   * transaction (fee payer) — the deployer. Absent when history is too deep
   * to resolve or RPC failed.
   */
  deployerAddress?: string;
  /**
   * Helius-parsed CREATE (token launch, e.g. pump.fun) transactions by the
   * deployer, capped at 100 (100 = "100 or more"). null = count unavailable.
   * ≥ SERIAL_DEPLOYER_MIN is the serial-deployer tell.
   */
  deployerTokensCreated?: number | null;
  /** When the deployer wallet first transacted (ms). null = unknown or deep history. */
  deployerWalletFirstSeenMs?: number | null;
  /**
   * Deployer history deeper than the signature-scan page budget — an
   * established wallet (definitely NOT fresh), exact age unknown.
   */
  deployerIsOldWallet?: boolean;
  /** DexScreener 24h buy/sell counts from the highest-liquidity pair. */
  buys24h?: number | null;
  sells24h?: number | null;
  /** DexScreener 6h buy/sell counts (corroborator). */
  buys6h?: number | null;
  sells6h?: number | null;
  /**
   * Safety verdict for this token. Only computed for the tokens it can change
   * a decision for (the scanned mint and rank 1) — absent elsewhere, which
   * means NOT ASSESSED, not safe.
   *
   * "danger" costs rank 1 the OG crown (see sort.ts) and bars it from the OG
   * registry. "unknown" means the checks could not run and must never render
   * as a clean result.
   */
  safetyLevel?: SafetyLevel;
  /**
   * Findings behind safetyLevel, CODES ONLY — labels and details are
   * re-derived client-side via flagFromCode() so payloads stay small.
   */
  safetyFlags?: SafetyFlagCode[];
}

/** Deployer launched ≥ this many tokens → flag as serial deployer. */
export const SERIAL_DEPLOYER_MIN = 10;
/** Deployer wallet younger than this → flag as fresh wallet. */
export const FRESH_WALLET_MS = 7 * 24 * 60 * 60 * 1000;
/** deployerTokensCreated is counted from one Enhanced-API page — the cap means "or more". */
export const TOKENS_CREATED_CAP = 100;

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
  /**
   * Creation ranking: the #1 answer is not proven (see
   * TokenResult.ageOrderUnproven). isScannedOG keeps its literal meaning
   * ("the scanned mint is rank 1") — this says whether rank 1 itself can be
   * asserted, so a consumer must not render a crown while it is true.
   */
  ageOrderUnproven?: true;
  /** Tokens in this response whose unresolved age blocks that proof. */
  ageUnresolvedCount?: number;
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
  | "ageOrderUnproven"
  | "ageUnresolvedCount"
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
/**
 * Off-chain metadata JSON lives on arbitrary third-party gateways (ipfs.io,
 * arweave.net, random project hosts). It is a nice-to-have on ONE mint per
 * scan, so it gets a short leash and never delays a verdict.
 */
export const OFFCHAIN_META_TIMEOUT = 4000;
/** Failed off-chain fetches are remembered only briefly — gateways flap. */
export const OFFCHAIN_META_FAIL_TTL = 300;
/**
 * CHEAP per-token dating budget for the bulk pass: 5 pages × 1000 signatures.
 * Every token in a cohort pays this, so it stays small; a token whose history
 * is deeper comes back truncated (a LOWER BOUND, never a date).
 */
export const MAX_SIG_PAGES = 5;
/**
 * DEEP budget for the handful of tokens whose truncation can change the #1
 * answer. 40 pages = 40,000 signatures.
 *
 * Sizing: the reported regression (Erb3CTbF… "COPEPE") reached its first
 * transaction at page 12 / 11,266 signatures — the 5-page budget reported a
 * date 18 months too recent. 40 gives 3.3× headroom over that measured worst
 * case. Tokens busier than 40k signatures are essentially all majors, which
 * carry a Helius DAS `created_at` and therefore never depend on the walk.
 * Deep walks are additionally bounded in wall-clock by DEEP_PHASE_BUDGET_MS
 * and resume from persisted progress, so hitting either bound costs accuracy
 * on that one token for one request, not correctness.
 */
export const DEEP_SIG_PAGES = 40;
/**
 * Max AMBIGUOUS truncated tokens escalated to a deep walk per scan, on top of
 * the always-resolved set (scanned mint + current rank 1). When more tokens
 * qualify than this, the overflow is reported — never silently dropped.
 */
export const MAX_DEEP_ESCALATIONS = 6;
/**
 * Wall-clock ceiling for the whole deep-resolution phase. Checked before each
 * additional page, so exceeding it stops the walk, persists progress, and
 * leaves the token an honest lower bound for a later scan to resume.
 *
 * Walks run concurrently, so this is (near enough) the phase's added latency:
 * the slowest walk, capped here. Measured 2026-08-08 against mainnet at
 * ~575ms/page, 12s buys ~20 pages — 3× what the reported regression needed
 * after its cheap pass. Bigger values mostly buy pages on tokens too busy to
 * finish at all, which resumption picks up on the next scan for free.
 */
export const DEEP_PHASE_BUDGET_MS = 12000;

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
