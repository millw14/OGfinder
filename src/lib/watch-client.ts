/**
 * Client-side watch storage (no accounts): localStorage keeps the
 * {id, secret} pairs returned by POST /api/watch — the secret is the only
 * credential, so losing storage means losing the watch. Guarded parses like
 * HomeClient's recents: malformed entries are dropped, storage failures are
 * non-fatal.
 */

export type WatchKindClient = "name" | "mint-cluster";

export interface StoredWatch {
  id: number;
  secret: string;
  query: string;
  kind: WatchKindClient;
  createdAt: number;
  /** Telegram deep-link from the POST response; absent when TG is disabled. */
  telegramLinkUrl?: string | null;
}

const WATCHES_KEY = "ogfinder_watches";
const ALERTS_SEEN_KEY = "ogfinder_alerts_seen";
/** Matches the server-side per-IP cap. */
export const MAX_STORED_WATCHES = 10;

/** Fired on window whenever the stored watch list changes (same-tab sync). */
export const WATCHES_CHANGED_EVENT = "ogfinder_watches_changed";

function isStoredWatch(v: unknown): v is StoredWatch {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "number" &&
    Number.isInteger(o.id) &&
    typeof o.secret === "string" &&
    o.secret.length > 0 &&
    typeof o.query === "string" &&
    (o.kind === "name" || o.kind === "mint-cluster") &&
    typeof o.createdAt === "number" &&
    (o.telegramLinkUrl === undefined ||
      o.telegramLinkUrl === null ||
      typeof o.telegramLinkUrl === "string")
  );
}

export function getStoredWatches(): StoredWatch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(WATCHES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredWatch);
  } catch {
    return [];
  }
}

function saveWatches(list: StoredWatch[]): void {
  try {
    localStorage.setItem(WATCHES_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
  try {
    window.dispatchEvent(new Event(WATCHES_CHANGED_EVENT));
  } catch {
    /* non-fatal */
  }
}

export function addStoredWatch(watch: StoredWatch): void {
  const list = getStoredWatches().filter((w) => w.id !== watch.id);
  list.unshift(watch);
  saveWatches(list.slice(0, MAX_STORED_WATCHES));
}

export function removeStoredWatch(id: number): void {
  saveWatches(getStoredWatches().filter((w) => w.id !== id));
}

/** The stored watch for a query+kind, if any (exact query string match). */
export function findStoredWatch(
  query: string,
  kind: WatchKindClient
): StoredWatch | undefined {
  return getStoredWatches().find((w) => w.kind === kind && w.query === query);
}

/** Timestamp (ms) up to which alerts have been seen; 0 when never set. */
export function getAlertsSeen(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = localStorage.getItem(ALERTS_SEEN_KEY);
    const parsed = raw != null ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function setAlertsSeen(ms: number): void {
  try {
    localStorage.setItem(ALERTS_SEEN_KEY, String(ms));
  } catch {
    /* non-fatal */
  }
}
