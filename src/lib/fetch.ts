import { recordFailure, recordSuccess } from "./provider-health";

/** Classified fetch failure. Message never includes the URL — some endpoints carry API keys in the query string. */
export class FetchError extends Error {
  kind: "http" | "timeout" | "network";
  status?: number;
  retryAfterMs?: number;

  constructor(
    kind: "http" | "timeout" | "network",
    message: string,
    status?: number,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Known API hosts → provider label (for health counters + degraded reporting). */
const HOST_PROVIDERS: Record<string, string> = {
  "api.dexscreener.com": "dexscreener",
  "lite-api.jup.ag": "jupiter",
  "mainnet.helius-rpc.com": "helius",
  "api.helius.xyz": "helius",
  "public-api.birdeye.so": "birdeye",
  "api.geckoterminal.com": "geckoterminal",
  "api.mainnet-beta.solana.com": "solana-rpc",
};

/** Per-host in-flight caps so one burst-heavy pipeline can't trip rate limits. */
const HOST_CONCURRENCY: Record<string, number> = {
  "api.dexscreener.com": 6,
  "lite-api.jup.ag": 3,
  "public-api.birdeye.so": 3,
  "api.geckoterminal.com": 4,
};

interface Semaphore {
  active: number;
  limit: number;
  queue: Array<() => void>;
}

const semaphores = new Map<string, Semaphore>();

async function acquire(host: string): Promise<(() => void) | null> {
  const limit = HOST_CONCURRENCY[host];
  if (!limit) return null;
  let sem = semaphores.get(host);
  if (!sem) {
    sem = { active: 0, limit, queue: [] };
    semaphores.set(host, sem);
  }
  if (sem.active < sem.limit) {
    sem.active += 1;
  } else {
    await new Promise<void>((resolve) => sem!.queue.push(resolve));
    sem.active += 1;
  }
  return () => {
    sem!.active -= 1;
    const next = sem!.queue.shift();
    if (next) next();
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(
  url: string,
  ms: number,
  init?: RequestInit
): Promise<unknown> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new FetchError("timeout", `Timeout after ${ms}ms`);
      }
      throw new FetchError("network", "Network error");
    }
    if (!res.ok) {
      throw new FetchError(
        "http",
        `HTTP ${res.status}`,
        res.status,
        parseRetryAfterMs(res)
      );
    }
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * JSON fetch with timeout, classified errors, bounded retry, and per-host caps.
 * Retries: idempotent GETs only, on actual 429/5xx responses only (never after
 * a timeout — that would double route latency budgets), max 2 attempts extra.
 */
export async function fetchWithTimeout(
  url: string,
  ms: number,
  init?: RequestInit
): Promise<unknown> {
  const host = hostOf(url);
  const provider = HOST_PROVIDERS[host];
  const release = await acquire(host);
  try {
    const isGet = (init?.method ?? "GET").toUpperCase() === "GET";
    let attempt = 0;
    for (;;) {
      try {
        const data = await fetchOnce(url, ms, init);
        if (provider) recordSuccess(provider);
        return data;
      } catch (err) {
        const fe = err instanceof FetchError ? err : null;
        const retryable =
          isGet &&
          fe?.kind === "http" &&
          fe.status !== undefined &&
          (fe.status === 429 || fe.status >= 500) &&
          attempt < MAX_RETRIES;
        if (!retryable) {
          if (provider) recordFailure(provider, fe?.kind ?? "unknown");
          throw err;
        }
        const backoff =
          fe.retryAfterMs !== undefined
            ? Math.min(fe.retryAfterMs, 2000)
            : 300 * 2 ** attempt + Math.floor(Math.random() * 100);
        attempt += 1;
        await sleep(backoff);
      }
    }
  } finally {
    release?.();
  }
}
