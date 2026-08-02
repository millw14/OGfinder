import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Rolling per-provider health counters + per-request failure collection.
 * Single-process by design (matches the in-memory caches and rate limiter).
 */

const WINDOW_MS = 5 * 60_000;
/** Cap per-provider timestamp ring so a hot failure loop can't grow memory. */
const MAX_SAMPLES = 500;

interface ProviderStat {
  errorTimes: number[];
  lastErrorAt: number | null;
  lastOkAt: number | null;
}

const stats = new Map<string, ProviderStat>();

function statFor(provider: string): ProviderStat {
  let s = stats.get(provider);
  if (!s) {
    s = { errorTimes: [], lastErrorAt: null, lastOkAt: null };
    stats.set(provider, s);
  }
  return s;
}

function trim(s: ProviderStat, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (s.errorTimes.length > 0 && s.errorTimes[0] < cutoff) {
    s.errorTimes.shift();
  }
  if (s.errorTimes.length > MAX_SAMPLES) {
    s.errorTimes.splice(0, s.errorTimes.length - MAX_SAMPLES);
  }
}

export function recordSuccess(provider: string): void {
  statFor(provider).lastOkAt = Date.now();
}

export function recordFailure(provider: string, _kind: string): void {
  const now = Date.now();
  const s = statFor(provider);
  s.errorTimes.push(now);
  s.lastErrorAt = now;
  trim(s, now);
  // Also tag the active request's failure collection, if any.
  failureStore.getStore()?.add(provider);
}

export function getProviderStats(): Record<
  string,
  { errors5m: number; lastErrorAt: number | null; lastOkAt: number | null }
> {
  const now = Date.now();
  const out: Record<
    string,
    { errors5m: number; lastErrorAt: number | null; lastOkAt: number | null }
  > = {};
  stats.forEach((s, provider) => {
    trim(s, now);
    out[provider] = {
      errors5m: s.errorTimes.length,
      lastErrorAt: s.lastErrorAt,
      lastOkAt: s.lastOkAt,
    };
  });
  return out;
}

const failureStore = new AsyncLocalStorage<Set<string>>();

/**
 * Run fn with an active failure-collection context; any provider that fails a
 * fetch inside it (after retries) lands in `degraded`.
 * Note: coalesced joiners awaiting another request's pipeline promise do not
 * inherit that pipeline's context — cache hits and joiners omit degraded.
 */
export async function runWithFailureCollection<T>(
  fn: () => Promise<T>
): Promise<{ value: T; degraded: string[] }> {
  const set = new Set<string>();
  const value = await failureStore.run(set, fn);
  return { value, degraded: Array.from(set) };
}

/** Providers that have failed so far in the active collection context. */
export function currentFailures(): string[] {
  const set = failureStore.getStore();
  return set ? Array.from(set) : [];
}
