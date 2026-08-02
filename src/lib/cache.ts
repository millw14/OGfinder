import NodeCache from "node-cache";
import {
  CACHE_SEARCH,
  CACHE_DEX,
  CACHE_HELIUS,
  CACHE_WALLET,
  HeliusSlotData,
} from "./types";
import type { EnhancedTx } from "./wallet-analysis";
import {
  getCreationSlotPersisted,
  setCreationSlotPersisted,
  getSearchCachePersisted,
  setSearchCachePersisted,
  maintenanceTick,
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

export function getCreationSlotCache(
  mint: string
): { slot: number; blockTime: number } | undefined {
  const hit = creationSlotCache.get<{ slot: number; blockTime: number }>(mint);
  if (hit) return hit;
  // L2: creation slots are immutable facts — no expiry, L1 is a memory bound.
  const persisted = getCreationSlotPersisted(mint);
  if (persisted) creationSlotCache.set(mint, persisted);
  return persisted;
}

export function setCreationSlotCache(
  mint: string,
  data: { slot: number; blockTime: number }
): void {
  creationSlotCache.set(mint, data);
  setCreationSlotPersisted(mint, data, true);
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
