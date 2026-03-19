import NodeCache from "node-cache";
import { CACHE_SEARCH, CACHE_DEX, CACHE_HELIUS } from "./types";

const searchCache = new NodeCache({ stdTTL: CACHE_SEARCH, checkperiod: 120 });
const dexCache = new NodeCache({ stdTTL: CACHE_DEX, checkperiod: 60 });
const heliusCache = new NodeCache({ stdTTL: CACHE_HELIUS, checkperiod: 120 });

export function getSearchCache<T>(key: string): T | undefined {
  return searchCache.get<T>(key);
}

export function setSearchCache<T>(key: string, value: T): void {
  searchCache.set(key, value);
}

export function getDexCache<T>(key: string): T | undefined {
  return dexCache.get<T>(key);
}

export function setDexCache<T>(key: string, value: T): void {
  dexCache.set(key, value);
}

export function getHeliusSlot(mint: string): { slot: number; blockTime: number } | undefined {
  return heliusCache.get(mint);
}

export function setHeliusSlot(mint: string, data: { slot: number; blockTime: number }): void {
  heliusCache.set(mint, data);
}
