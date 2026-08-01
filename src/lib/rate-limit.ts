/**
 * Simple in-memory per-IP token bucket rate limiter. Dependency-free.
 * Sustained rate refills continuously; burst is the bucket capacity.
 * Suitable for a single-process deployment (dev server / one serverless
 * instance) — not a distributed limiter.
 */

export interface RateLimitOptions {
  /** Sustained refill rate, tokens per minute. */
  ratePerMin: number;
  /** Bucket capacity — max requests allowed in a burst. */
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  ratePerMin: 30,
  burst: 10,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

/** Safety cap so a spray of unique IPs can't grow the map unbounded. */
const MAX_BUCKETS = 10_000;

/** First x-forwarded-for hop, else 'local' (direct / dev). */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
}

function pruneBuckets(now: number, opts: RateLimitOptions): void {
  // Drop buckets idle long enough to have fully refilled — they carry no state.
  const fullRefillMs = (opts.burst / opts.ratePerMin) * 60_000;
  buckets.forEach((b, key) => {
    if (now - b.lastRefillMs > fullRefillMs) buckets.delete(key);
  });
  // Hard fallback: still oversized means we're being sprayed — reset.
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

/**
 * Consume one token from the caller's bucket.
 * Returns { allowed: false, retryAfterSec } when the bucket is empty.
 */
export function consumeRateLimit(
  ip: string,
  opts: RateLimitOptions = DEFAULT_RATE_LIMIT
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) pruneBuckets(now, opts);
    bucket = { tokens: opts.burst, lastRefillMs: now };
    buckets.set(ip, bucket);
  }

  const refillPerMs = opts.ratePerMin / 60_000;
  bucket.tokens = Math.min(
    opts.burst,
    bucket.tokens + (now - bucket.lastRefillMs) * refillPerMs
  );
  bucket.lastRefillMs = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  const retryAfterSec = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
  return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
}

/**
 * Convenience for API routes: rate-limit by request headers.
 * Returns null when allowed, or 429 payload details when exceeded.
 */
export function rateLimitRequest(
  headers: Headers,
  opts: RateLimitOptions = DEFAULT_RATE_LIMIT
): { status: 429; error: string; retryAfterSec: number } | null {
  const { allowed, retryAfterSec } = consumeRateLimit(
    clientIpFromHeaders(headers),
    opts
  );
  if (allowed) return null;
  return { status: 429, error: "Too many requests", retryAfterSec };
}
