import NodeCache from "node-cache";
import {
  CACHE_SEARCH,
  CACHE_DEX,
  CACHE_HELIUS,
  CACHE_WALLET,
  HeliusSlotData,
} from "./types";
import type { EnhancedTx } from "./wallet-analysis";
import type { MintExtensionFacts } from "./safety";
import {
  getCreationSlotPersisted,
  setCreationSlotPersisted,
  getCreationProgress,
  setCreationProgressPersisted,
  getSearchCachePersisted,
  setSearchCachePersisted,
  maintenanceTick,
  type CreationProgressRow,
} from "./store";

const searchCache = new NodeCache({ stdTTL: CACHE_SEARCH, checkperiod: 120 });
const dexCache = new NodeCache({ stdTTL: CACHE_DEX, checkperiod: 60 });
/** Full DAS metadata per mint (name/symbol/interface/supply/createdAt). */
const heliusMetaCache = new NodeCache({ stdTTL: CACHE_HELIUS, checkperiod: 120 });
/** Creation slot/blockTime per mint from signature scans — real blockTimes only. */
const creationSlotCache = new NodeCache({ stdTTL: CACHE_HELIUS, checkperiod: 120 });

export function getSearchCache<T>(key: string): T | undefined {
  const hit = searchCache.get<T>(key);
  if (hit !== undefined) return hit;
  // L2: SQLite-persisted full results survive restarts/redeploys.
  const persisted = getSearchCachePersisted<T>(key);
  if (!persisted) return undefined;
  const remainingSec = Math.ceil((persisted.expiresAtMs - Date.now()) / 1000);
  if (remainingSec <= 0) return undefined;
  searchCache.set(key, persisted.value, remainingSec);
  return persisted.value;
}

export function setSearchCache<T>(key: string, value: T, ttl?: number): void {
  if (ttl !== undefined) {
    // Short-lived entries (fast phase / negative) stay memory-only.
    searchCache.set(key, value, ttl);
  } else {
    searchCache.set(key, value);
    setSearchCachePersisted(key, value, Date.now() + CACHE_SEARCH * 1000);
  }
  maintenanceTick();
}

export function getDexCache<T>(key: string): T | undefined {
  return dexCache.get<T>(key);
}

export function setDexCache<T>(key: string, value: T): void {
  dexCache.set(key, value);
}

export function getHeliusMeta(mint: string): HeliusSlotData | undefined {
  return heliusMetaCache.get(mint);
}

export function setHeliusMeta(mint: string, data: HeliusSlotData): void {
  heliusMetaCache.set(mint, data);
}

/**
 * Token-2022 mint extensions per mint. Extensions are set at mint creation and
 * change very rarely, so they share the long DAS metadata TTL. Only successful
 * reads are cached — a failed read must stay "unknown" and be retried.
 */
const mintExtensionsCache = new NodeCache({
  stdTTL: CACHE_HELIUS,
  checkperiod: 120,
});

export function getMintExtensionsCache(
  mint: string
): MintExtensionFacts | undefined {
  return mintExtensionsCache.get(mint);
}

export function setMintExtensionsCache(
  mint: string,
  data: MintExtensionFacts
): void {
  mintExtensionsCache.set(mint, data);
}

export function getCreationSlotCache(
  mint: string
): { slot: number; blockTime: number; signature?: string } | undefined {
  const hit = creationSlotCache.get<{
    slot: number;
    blockTime: number;
    signature?: string;
  }>(mint);
  if (hit) return hit;
  // L2: creation slots are immutable facts — no expiry, L1 is a memory bound.
  // (The oldest signature is L1-only; L2 hits come back without it.)
  const persisted = getCreationSlotPersisted(mint);
  if (persisted) creationSlotCache.set(mint, persisted);
  return persisted;
}

export function setCreationSlotCache(
  mint: string,
  data: { slot: number; blockTime: number; signature?: string }
): void {
  creationSlotCache.set(mint, data);
  setCreationSlotPersisted(
    mint,
    { slot: data.slot, blockTime: data.blockTime },
    true
  );
}

/**
 * Resume point of an UNFINISHED signature walk. Deliberately L2-only and kept
 * out of creationSlotCache: an incomplete walk is a lower bound, and the L1/L2
 * creation-slot path exists to serve finished answers. Callers get this only by
 * asking for it explicitly.
 */
export function getCreationWalkProgress(
  mint: string
): CreationProgressRow | undefined {
  return getCreationProgress(mint);
}

/**
 * Record how deep an unfinished walk got so the next deep scan resumes there.
 * Never touches L1 — nothing here may be served as a creation date.
 */
export function setCreationWalkProgress(
  mint: string,
  data: {
    slot: number;
    blockTime: number;
    deepestSig: string | null;
    pagesWalked: number;
  }
): void {
  setCreationProgressPersisted(mint, data);
}

const walletCache = new NodeCache({ stdTTL: CACHE_WALLET, checkperiod: 60 });

export function getWalletCache<T>(key: string): T | undefined {
  return walletCache.get<T>(key);
}

export function setWalletCache<T>(key: string, value: T): void {
  walletCache.set(key, value);
}

/** Deep-scan cap: stop offering "scan more" once this many txs are analyzed. */
export const MAX_DEEP_TXS = 2000;

/** Raw enhanced-tx window per wallet + cursor for the deep-scan resume. */
export interface WalletTxCacheEntry {
  /** Fetched txs, newest-first (merged across deepen rounds). */
  txs: EnhancedTx[];
  /** Cursor (oldest fetched signature) to resume older history; null = exhausted. */
  nextBefore: string | null;
}

// useClones: false — entries are large (up to MAX_DEEP_TXS tx objects) and
// treated as immutable by every reader; cloning them on get/set is pure cost.
const walletTxCache = new NodeCache({
  stdTTL: 900,
  checkperiod: 120,
  useClones: false,
});

export function getWalletTxCache(
  address: string
): WalletTxCacheEntry | undefined {
  return walletTxCache.get(address);
}

export function setWalletTxCache(
  address: string,
  entry: WalletTxCacheEntry
): void {
  walletTxCache.set(address, entry);
}
