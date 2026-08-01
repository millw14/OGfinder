import NodeCache from "node-cache";
import {
  CACHE_SEARCH,
  CACHE_DEX,
  CACHE_HELIUS,
  CACHE_WALLET,
  HeliusSlotData,
} from "./types";

const searchCache = new NodeCache({ stdTTL: CACHE_SEARCH, checkperiod: 120 });
const dexCache = new NodeCache({ stdTTL: CACHE_DEX, checkperiod: 60 });
/** Full DAS metadata per mint (name/symbol/interface/supply/createdAt). */
const heliusMetaCache = new NodeCache({ stdTTL: CACHE_HELIUS, checkperiod: 120 });
/** Creation slot/blockTime per mint from signature scans — real blockTimes only. */
const creationSlotCache = new NodeCache({ stdTTL: CACHE_HELIUS, checkperiod: 120 });

export function getSearchCache<T>(key: string): T | undefined {
  return searchCache.get<T>(key);
}

export function setSearchCache<T>(key: string, value: T, ttl?: number): void {
  if (ttl !== undefined) {
    searchCache.set(key, value, ttl);
  } else {
    searchCache.set(key, value);
  }
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
  return creationSlotCache.get(mint);
}

export function setCreationSlotCache(
  mint: string,
  data: { slot: number; blockTime: number }
): void {
  creationSlotCache.set(mint, data);
}

const walletCache = new NodeCache({ stdTTL: CACHE_WALLET, checkperiod: 60 });

export function getWalletCache<T>(key: string): T | undefined {
  return walletCache.get<T>(key);
}

export function setWalletCache<T>(key: string, value: T): void {
  walletCache.set(key, value);
}
