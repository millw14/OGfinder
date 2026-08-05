import {
  HeliusSlotData,
  HELIUS_TIMEOUT,
  MAX_SIG_PAGES,
  TOKENS_CREATED_CAP,
} from "./types";
import { fetchWithTimeout } from "./fetch";
import {
  getHeliusMeta,
  setHeliusMeta,
  getCreationSlotCache,
  setCreationSlotCache,
  getMintExtensionsCache,
  setMintExtensionsCache,
} from "./cache";
import type { MintExtensionFacts } from "./safety";
import {
  getDeployerPersisted,
  setDeployerPersisted,
  getDeployerProfilePersisted,
  setDeployerProfilePersisted,
} from "./store";

/** Public read-only fallback when HELIUS_API_KEY is missing on the server (e.g. Vercel env not set). */
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function getHeliusDasRpcUrl(): string | null {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

/**
 * Standard JSON-RPC (getAccountInfo, getSignaturesForAddress): Helius if key is set,
 * else SOLANA_RPC_URL, else public mainnet — so mint scan works without DAS credentials.
 */
function getStandardJsonRpcUrl(): string {
  return (
    getHeliusDasRpcUrl() ??
    (process.env.SOLANA_RPC_URL?.trim() || PUBLIC_MAINNET_RPC)
  );
}

async function jsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "ogfinder",
    method,
    params,
  });

  return fetchWithTimeout(url, HELIUS_TIMEOUT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  token_info?: {
    supply?: number;
    /** Base58 authority when active; key omitted by DAS when revoked. */
    mint_authority?: string | null;
    freeze_authority?: string | null;
  };
  supply?: {
    print_current_supply?: number;
  };
  slot?: number;
  created_at?: string;
  /** Metaplex metadata mutability — always a boolean on DAS assets. */
  mutable?: boolean;
}

interface SignatureResult {
  slot: number;
  blockTime: number;
  signature: string;
}

async function standardRpc(method: string, params: unknown): Promise<unknown> {
  return jsonRpc(getStandardJsonRpcUrl(), method, params);
}

export async function getAssetBatch(
  mints: string[]
): Promise<Map<string, HeliusSlotData>> {
  const result = new Map<string, HeliusSlotData>();

  const uncached: string[] = [];
  for (const mint of mints) {
    const cached = getHeliusMeta(mint);
    if (cached) {
      result.set(mint, cached);
    } else {
      uncached.push(mint);
    }
  }

  if (uncached.length === 0) return result;

  const dasUrl = getHeliusDasRpcUrl();
  if (!dasUrl) {
    return result;
  }

  try {
    const response = (await jsonRpc(dasUrl, "getAssetBatch", {
      ids: uncached,
    })) as { result?: HeliusAsset[] };

    const assets = response?.result;
    if (!Array.isArray(assets)) return result;

    for (const asset of assets) {
      if (!asset?.id) continue;

      const supply =
        asset.token_info?.supply ??
        asset.supply?.print_current_supply ??
        null;

      const data: HeliusSlotData = {
        slot: asset.slot ?? null,
        createdAt: asset.created_at ?? null,
        heliusName: asset.content?.metadata?.name ?? null,
        heliusSymbol: asset.content?.metadata?.symbol ?? null,
        tokenInterface: asset.interface ?? null,
        supply,
        // Rug-risk signals — only when DAS actually reported them (undefined = unknown)
        ...(asset.token_info
          ? {
              mintAuthorityActive: asset.token_info.mint_authority != null,
              freezeAuthorityActive: asset.token_info.freeze_authority != null,
            }
          : {}),
        ...(typeof asset.mutable === "boolean"
          ? { metadataMutable: asset.mutable }
          : {}),
      };

      result.set(asset.id, data);
      setHeliusMeta(asset.id, data);
    }
  } catch {
    // Graceful fallback — tokens without data sort by other signals
  }

  return result;
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * When DAS getAssetBatch has no record (unindexed mint), fall back to standard
 * RPC getAccountInfo(jsonParsed) to detect an SPL mint account.
 */
function parseMintFromGetAccountResponse(response: unknown): HeliusSlotData | null {
  const r = response as {
    result?: {
      value: null | {
        owner?: string;
        data?: {
          program?: string;
          parsed?: {
            type?: string;
            info?: {
              supply?: string;
              /** Base58 when active; omitted/null when revoked (COption::None). */
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
            };
          };
        };
      };
    };
    error?: { message?: string };
  };
  if (r?.error) return null;

  const value = r?.result?.value;
  if (!value || typeof value !== "object") return null;

  const owner = value.owner;
  if (owner !== SPL_TOKEN_PROGRAM && owner !== SPL_TOKEN_2022_PROGRAM) {
    return null;
  }

  const parsed = value.data?.parsed;
  if (parsed?.type !== "mint") return null;

  const supplyStr = parsed.info?.supply;
  const supply =
    supplyStr != null && supplyStr !== "" ? Number(supplyStr) : null;

  return {
    slot: null,
    createdAt: null,
    heliusName: null,
    heliusSymbol: null,
    tokenInterface: "FungibleToken",
    supply: Number.isFinite(supply) ? supply : null,
    // jsonParsed mint account carries authorities; metadata mutability stays unknown here
    ...(parsed.info
      ? {
          mintAuthorityActive: parsed.info.mintAuthority != null,
          freezeAuthorityActive: parsed.info.freezeAuthority != null,
        }
      : {}),
  };
}

export async function getMintHeliusDataRpcFallback(
  mint: string
): Promise<HeliusSlotData | null> {
  const params = [mint, { encoding: "jsonParsed" }];
  const urls = [
    getStandardJsonRpcUrl(),
    PUBLIC_MAINNET_RPC,
    process.env.SOLANA_RPC_URL?.trim(),
  ].filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);

  for (const url of urls) {
    try {
      const response = await jsonRpc(url, "getAccountInfo", params);
      const parsed = parseMintFromGetAccountResponse(response);
      if (parsed) return parsed;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// ————————————————— Token-2022 extensions (honeypot machinery) —————————————————

/**
 * jsonParsed shape of one Token-2022 extension. VERIFIED against mainnet
 * (2026-08) — see parseMintExtensions for the per-extension evidence.
 */
interface ParsedExtension {
  extension?: string;
  state?: {
    /** transferHook: null when no hook program is installed (inert). */
    programId?: string | null;
    /** permanentDelegate */
    delegate?: string | null;
    /** defaultAccountState: "frozen" | "initialized" */
    accountState?: string | null;
    /** transferFeeConfig */
    newerTransferFee?: { transferFeeBasisPoints?: number };
    olderTransferFee?: { transferFeeBasisPoints?: number };
  } | null;
}

/** COption::None renders as null; the all-ones default pubkey means unset too. */
const UNSET_PUBKEY = "11111111111111111111111111111111";

function realAddress(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v !== UNSET_PUBKEY ? v : null;
}

/**
 * Parse getAccountInfo(jsonParsed) into the extension facts the safety engine
 * needs. Exported for unit tests. Returns null when the response is not a
 * readable token mint — null always means UNKNOWN, never "no extensions".
 *
 * Shapes verified live on mainnet 2026-08:
 *   transferHook       {"state":{"authority":"..","programId":null}}  (PYUSD, PUMP)
 *                      programId "tHookmPkFZDJGkS9us6sVsnYi2EKHCrVtw8zD6oXYPE"
 *                      on 12AR5yihid9wxUHDf5xKqLpPkRX4nyaSKiAD7LXmLBu
 *   permanentDelegate  {"state":{"delegate":"2apBGMsS.."}}            (PYUSD)
 *   transferFeeConfig  {"state":{"newerTransferFee":{"transferFeeBasisPoints":20},..}}
 *   defaultAccountState{"state":{"accountState":"frozen"}}
 *                      on 15YGYD1afQzrdjuzJBDonV7U5yPyBJs7qT5MQBLP49b
 *   nonTransferable    NOT observed live (such tokens cannot trade on a DEX);
 *                      parsed defensively off the extension NAME alone, which
 *                      holds whether or not the parser emits a state object.
 */
export function parseMintExtensions(
  response: unknown
): MintExtensionFacts | null {
  const r = response as {
    result?: {
      value?: null | {
        owner?: string;
        data?: {
          parsed?: {
            type?: string;
            info?: {
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
              extensions?: unknown;
            };
          };
        };
      };
    };
    error?: unknown;
  };
  if (r?.error) return null;

  const value = r?.result?.value;
  if (!value || typeof value !== "object") return null;

  const owner = value.owner;
  const isToken2022 = owner === SPL_TOKEN_2022_PROGRAM;
  if (owner !== SPL_TOKEN_PROGRAM && !isToken2022) return null;

  const parsed = value.data?.parsed;
  if (parsed?.type !== "mint") return null;
  const info = parsed.info;

  const facts: MintExtensionFacts = {
    hasTransferHook: false,
    nonTransferable: false,
    defaultAccountFrozen: false,
    permanentDelegate: null,
    transferFeeBps: null,
    isToken2022,
  };
  if (info) {
    facts.mintAuthorityActive = realAddress(info.mintAuthority) !== null;
    facts.freezeAuthorityActive = realAddress(info.freezeAuthority) !== null;
  }

  // A legacy SPL mint has no extensions — a successful read, zero findings.
  const list = info?.extensions;
  if (!Array.isArray(list)) return facts;

  for (const raw of list) {
    const e = raw as ParsedExtension;
    const state = e?.state ?? undefined;
    switch (e?.extension) {
      case "transferHook":
        // Only a REAL hook program can revert a sell; a null hook is inert.
        if (realAddress(state?.programId)) facts.hasTransferHook = true;
        break;
      case "nonTransferable":
      case "nonTransferableAccount":
        facts.nonTransferable = true;
        break;
      case "defaultAccountState":
        if (state?.accountState === "frozen") facts.defaultAccountFrozen = true;
        break;
      case "permanentDelegate": {
        const delegate = realAddress(state?.delegate);
        if (delegate) facts.permanentDelegate = delegate;
        break;
      }
      case "transferFeeConfig": {
        const bps =
          state?.newerTransferFee?.transferFeeBasisPoints ??
          state?.olderTransferFee?.transferFeeBasisPoints;
        if (typeof bps === "number" && Number.isFinite(bps)) {
          facts.transferFeeBps = bps;
        }
        break;
      }
      default:
        break;
    }
  }

  return facts;
}

/**
 * Read a mint's Token-2022 extensions (plus its live authorities, which come
 * in the same account read for free). Cached — extensions change rarely.
 *
 * Returns null on ANY failure, which the safety engine reads as "check did not
 * run" → unknown. It must never be read as "no dangerous extensions".
 */
export async function getMintExtensions(
  mint: string
): Promise<MintExtensionFacts | null> {
  try {
    const cached = getMintExtensionsCache(mint);
    if (cached) return cached;

    const params = [mint, { encoding: "jsonParsed" }];
    const urls = [
      getStandardJsonRpcUrl(),
      PUBLIC_MAINNET_RPC,
      process.env.SOLANA_RPC_URL?.trim(),
    ].filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);

    for (const url of urls) {
      try {
        const response = await jsonRpc(url, "getAccountInfo", params);
        const facts = parseMintExtensions(response);
        if (facts) {
          setMintExtensionsCache(mint, facts);
          return facts;
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure math behind getTopHolderShare — exported for unit tests. `amounts` are
 * raw token amounts in descending order (as getTokenLargestAccounts returns
 * them); non-finite/negative entries are dropped. Percentages are clamped to
 * 100 because raw supplies above 2^53 lose precision in Number().
 */
export function computeHolderShare(
  amounts: number[],
  supply: number
): { topTenPct: number; largestPct: number } | null {
  if (!Number.isFinite(supply) || supply <= 0) return null;
  const valid = amounts.filter((a) => Number.isFinite(a) && a >= 0);
  if (valid.length === 0) return null;
  const topTen = valid.slice(0, 10).reduce((sum, a) => sum + a, 0);
  return {
    topTenPct: Math.min(100, (100 * topTen) / supply),
    largestPct: Math.min(100, (100 * valid[0]) / supply),
  };
}

/**
 * Share of supply in the largest token accounts via getTokenLargestAccounts.
 * Includes LP pools and burn addresses — an UPPER BOUND on wallet
 * concentration. Falls back to getTokenSupply when the caller has no DAS
 * supply. Any failure returns null.
 */
export async function getTopHolderShare(
  mint: string,
  supplyRaw: number | null
): Promise<{ topTenPct: number; largestPct: number } | null> {
  try {
    const response = (await standardRpc("getTokenLargestAccounts", [
      mint,
      { commitment: "confirmed" },
    ])) as {
      result?: {
        value?: {
          address: string;
          amount: string;
          decimals: number;
          uiAmount: number | null;
        }[];
      };
    };
    const accounts = response?.result?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    let supply =
      supplyRaw != null && Number.isFinite(supplyRaw) && supplyRaw > 0
        ? supplyRaw
        : null;
    if (supply == null) {
      const supplyResponse = (await standardRpc("getTokenSupply", [mint])) as {
        result?: { value?: { amount?: string } };
      };
      const amount = supplyResponse?.result?.value?.amount;
      const parsed = amount != null && amount !== "" ? Number(amount) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) supply = parsed;
    }
    if (supply == null) return null;

    return computeHolderShare(
      accounts.map((a) => Number(a?.amount)),
      supply
    );
  } catch {
    return null;
  }
}

/**
 * Backward-paginate getSignaturesForAddress to the address's very first
 * transaction. limit:1000 per page, up to MAX_SIG_PAGES pages; truncated=true
 * means the oldest page was still full — the result is only a lower bound.
 * Throws on RPC failure (callers wrap).
 */
async function findOldestSignature(
  address: string
): Promise<{ oldest: SignatureResult; truncated: boolean } | null> {
  let before: string | undefined = undefined;
  let oldestSig: SignatureResult | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const params: [string, { limit: number; before?: string }] = [
      address,
      { limit: 1000 },
    ];
    if (before) params[1].before = before;

    const response = (await standardRpc(
      "getSignaturesForAddress",
      params
    )) as { result?: SignatureResult[] };

    const sigs = response?.result;
    if (!Array.isArray(sigs) || sigs.length === 0) {
      truncated = false;
      break;
    }

    oldestSig = sigs[sigs.length - 1];
    before = oldestSig.signature;

    // If fewer than 1000 results, we've reached the beginning
    if (sigs.length < 1000) {
      truncated = false;
      break;
    }

    // Full page: if we run out of pages here, oldest time is only a lower bound
    truncated = true;
  }

  if (!oldestSig) return null;
  return { oldest: oldestSig, truncated };
}

/**
 * Get the actual creation slot/blockTime for a mint by paginating backward
 * through getSignaturesForAddress until we find the very first transaction.
 *
 * The oldest signature rides along in the L1 cache only (deployer resolution
 * uses it); L2 persists just slot/blockTime as before.
 */
export async function getCreationSlot(
  mint: string
): Promise<{
  slot: number;
  blockTime: number;
  truncated: boolean;
  signature?: string;
} | null> {
  const cached = getCreationSlotCache(mint);
  if (cached) return { ...cached, truncated: false };

  try {
    const found = await findOldestSignature(mint);
    if (!found) return null;

    const data = {
      slot: found.oldest.slot,
      blockTime: found.oldest.blockTime,
      signature: found.oldest.signature,
    };
    // Only cache complete scans with real blockTimes — truncated results are a
    // lower bound, so leave them uncached for a later deeper look to retry.
    if (!found.truncated && data.blockTime > 0) {
      setCreationSlotCache(mint, data);
    }
    return { ...data, truncated: found.truncated };
  } catch {
    return null;
  }
}

// ————————————————————— Deployer intelligence —————————————————————

/**
 * Resolve the wallet that deployed a mint: fee payer (accountKeys[0]) of the
 * mint's very first transaction. Persisted in creation_slots.deployer so
 * repeats are free. Truncated history (mint older than MAX_SIG_PAGES pages) or
 * any RPC failure → null. Never throws.
 */
export async function getDeployer(mint: string): Promise<string | null> {
  const persisted = getDeployerPersisted(mint);
  if (persisted) return persisted;

  try {
    // The scan pipeline has usually just run getCreationSlot(mint) — the L1
    // hit carries the oldest signature for free. L2-only hits (post-restart)
    // lack the signature and re-run the bounded pagination once.
    const cs = await getCreationSlot(mint);
    if (!cs || cs.truncated) return null;

    let sig = cs.signature;
    let slot = cs.slot;
    let blockTime = cs.blockTime;
    if (!sig) {
      const found = await findOldestSignature(mint);
      if (!found || found.truncated) return null;
      sig = found.oldest.signature;
      slot = found.oldest.slot;
      blockTime = found.oldest.blockTime;
    }

    const response = (await standardRpc("getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ])) as {
      result?: {
        transaction?: {
          message?: {
            accountKeys?: ({ pubkey?: string } | string)[];
          };
        };
      };
    };
    const first = response?.result?.transaction?.message?.accountKeys?.[0];
    const deployer =
      typeof first === "string" ? first : first?.pubkey ?? null;
    if (!deployer || typeof deployer !== "string") return null;

    setDeployerPersisted(mint, deployer, { slot, blockTime });
    return deployer;
  } catch {
    return null;
  }
}

/** Deployer profiles are refreshed after 24h — wallets keep launching tokens. */
export const DEPLOYER_PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;

/** True while a persisted deployer profile is inside the freshness window. */
export function isDeployerProfileFresh(
  checkedAt: number,
  now = Date.now()
): boolean {
  return now - checkedAt < DEPLOYER_PROFILE_FRESH_MS;
}

export interface DeployerProfile {
  /**
   * Helius-parsed CREATE (token launch, e.g. pump.fun) transactions by this
   * wallet, capped at TOKENS_CREATED_CAP. null = count unavailable.
   * NOT DAS searchAssets(creatorAddress): pump.fun mints carry an empty
   * on-chain creators array, so that query returns 0 for exactly the wallets
   * we care about (verified empirically 2026-08).
   */
  tokensCreated: number | null;
  /** blockTime of the wallet's first transaction (ms). null = unknown or too deep. */
  walletFirstSeenMs: number | null;
  /** History deeper than MAX_SIG_PAGES pages — an established wallet, not a fresh one. */
  isOldWallet: boolean;
  checkedAt: number;
}

/**
 * Count token-launch transactions via the Helius Enhanced Transactions API
 * (type=CREATE — pump.fun launches are CREATE/PUMP_FUN). One page, capped.
 * Throws on fetch failure (caller maps to null).
 */
async function countDeployerCreates(deployer: string): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  const url =
    `https://api.helius.xyz/v0/addresses/${encodeURIComponent(deployer)}` +
    `/transactions?api-key=${encodeURIComponent(key)}` +
    `&type=CREATE&limit=${TOKENS_CREATED_CAP}`;
  const res = await fetchWithTimeout(url, HELIUS_TIMEOUT);
  if (!Array.isArray(res)) return null;
  return Math.min(res.length, TOKENS_CREATED_CAP);
}

/**
 * Profile a deployer wallet: launch count + wallet age. Served from the
 * deployer_profiles table while fresh (<24h); refreshed on expiry. A profile
 * with no signal at all (both lookups failed) is returned but never persisted,
 * so a transient outage can't pin nulls for 24h. Never throws.
 */
export async function getDeployerProfile(
  deployer: string
): Promise<DeployerProfile | null> {
  try {
    const cached = getDeployerProfilePersisted(deployer);
    if (cached && isDeployerProfileFresh(cached.checkedAt)) return cached;

    let tokensCreated: number | null = null;
    try {
      tokensCreated = await countDeployerCreates(deployer);
    } catch {
      tokensCreated = null;
    }

    // Wallet age via the same first-transaction machinery mints use —
    // truncated pagination means deep history: old wallet, exact date unknown.
    let walletFirstSeenMs: number | null = null;
    let isOldWallet = false;
    const cs = await getCreationSlot(deployer);
    if (cs) {
      if (cs.truncated) {
        isOldWallet = true;
      } else if (cs.blockTime > 0) {
        walletFirstSeenMs = cs.blockTime * 1000;
      }
    }

    const profile: DeployerProfile = {
      tokensCreated,
      walletFirstSeenMs,
      isOldWallet,
      checkedAt: Date.now(),
    };
    if (tokensCreated != null || walletFirstSeenMs != null || isOldWallet) {
      setDeployerProfilePersisted(deployer, profile);
    }
    return profile;
  } catch {
    return null;
  }
}
