import crypto from "crypto";
import { getDb } from "./url-index";
import { skeleton } from "./normalize";
import type { NewDiscovery } from "./discovery";

/**
 * Watchlists without accounts: a watch is (query skeleton, secret). The client
 * keeps {id, secret} in localStorage; the secret alone authorizes reads and
 * deletion. The poller matches every tick's NewDiscovery batch against all
 * watches and inserts `alerts` rows (in-app; Telegram delivery comes later).
 *
 * matchDiscoveriesAgainstWatches swallows all failures — it runs inside the
 * poller tick and must never kill it. createWatch/deleteWatch/
 * getAlertsForWatches may throw on DB failure; API routes try/catch them.
 */

export type WatchKind = "name" | "mint-cluster";
export type WatchMatchMode = "exact" | "contains";

/** Per-IP cap on active watches. */
const MAX_WATCHES_PER_IP = 10;
/** Global cap on active watches (matching is O(watches × discoveries)). */
const MAX_WATCHES_TOTAL = 2000;
/** Contains-matching needs a distinctive skeleton; shorter ones match exact. */
const EXACT_MODE_BELOW = 5;
/** Max alerts inserted per watch per UTC day. */
const DAILY_ALERT_CAP = 25;
/** Boost churn re-surfaces old pairs — only alert on genuinely young tokens.
 *  Unknown pair age still alerts (most first sightings have no pair yet). */
const ALERT_MAX_TOKEN_AGE_MS = 72 * 60 * 60 * 1000;
/** Max watch pairs per getAlertsForWatches call. */
const MAX_ALERT_PAIRS = 10;
/** Max alerts returned per watch. */
const MAX_ALERTS_PER_WATCH = 50;

export interface CreateWatchInput {
  query: string;
  kind?: WatchKind;
  originMint?: string | null;
  ip: string;
}

export interface CreatedWatch {
  id: number;
  secret: string;
  kind: WatchKind;
  displayQuery: string;
  querySkeleton: string;
  matchMode: WatchMatchMode;
  originMint: string | null;
  /** True when an identical ip+skeleton watch already existed (idempotent). */
  existing: boolean;
}

export type CreateWatchResult =
  | { ok: true; watch: CreatedWatch }
  | { ok: false; error: "invalid" | "limit" | "full" };

export interface WatchAlertRow {
  id: number;
  kind: "clone" | "flip";
  mint: string | null;
  name: string | null;
  symbol: string | null;
  source: string | null;
  matchedAt: number;
  payload?: unknown;
}

export interface WatchWithAlerts {
  id: number;
  displayQuery: string;
  kind: WatchKind;
  telegramLinked: boolean;
  alerts: WatchAlertRow[];
}

/** Constant-time secret check; length mismatch and missing row both fail. */
function secretMatches(stored: string | undefined, provided: string): boolean {
  const a = Buffer.from(stored ?? "", "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** UTC calendar day for the daily alert cap, e.g. "2026-08-02". */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createWatch(input: CreateWatchInput): CreateWatchResult {
  const query = input.query?.trim() ?? "";
  if (query.length < 2 || query.length > 30) {
    return { ok: false, error: "invalid" };
  }
  const querySkeleton = skeleton(query);
  if (querySkeleton.length < 2) return { ok: false, error: "invalid" };
  const kind: WatchKind = input.kind === "mint-cluster" ? "mint-cluster" : "name";
  const originMint =
    kind === "mint-cluster" && input.originMint?.trim()
      ? input.originMint.trim()
      : null;
  const matchMode: WatchMatchMode =
    querySkeleton.length < EXACT_MODE_BELOW ? "exact" : "contains";
  const ip = input.ip || "local";

  const db = getDb();
  let result: CreateWatchResult | undefined;
  const tx = db.transaction(() => {
    // Idempotent: the same ip re-watching the same skeleton gets its watch back.
    const existing = db
      .prepare(
        `SELECT id, kind, display_query, origin_mint, match_mode, secret
         FROM watched_queries WHERE created_by_ip = ? AND query_skeleton = ?`
      )
      .get(ip, querySkeleton) as
      | {
          id: number;
          kind: WatchKind;
          display_query: string;
          origin_mint: string | null;
          match_mode: WatchMatchMode;
          secret: string;
        }
      | undefined;
    if (existing) {
      result = {
        ok: true,
        watch: {
          id: existing.id,
          secret: existing.secret,
          kind: existing.kind,
          displayQuery: existing.display_query,
          querySkeleton,
          matchMode: existing.match_mode,
          originMint: existing.origin_mint,
          existing: true,
        },
      };
      return;
    }
    const ipCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM watched_queries WHERE created_by_ip = ?"
        )
        .get(ip) as { cnt: number }
    ).cnt;
    if (ipCount >= MAX_WATCHES_PER_IP) {
      result = { ok: false, error: "limit" };
      return;
    }
    const total = (
      db.prepare("SELECT COUNT(*) AS cnt FROM watched_queries").get() as {
        cnt: number;
      }
    ).cnt;
    if (total >= MAX_WATCHES_TOTAL) {
      result = { ok: false, error: "full" };
      return;
    }
    const secret = crypto.randomBytes(16).toString("hex");
    const info = db
      .prepare(
        `INSERT INTO watched_queries
           (kind, query_skeleton, display_query, origin_mint, match_mode, secret, created_by_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(kind, querySkeleton, query, originMint, matchMode, secret, ip, Date.now());
    markWatchCacheDirty();
    result = {
      ok: true,
      watch: {
        id: Number(info.lastInsertRowid),
        secret,
        kind,
        displayQuery: query,
        querySkeleton,
        matchMode,
        originMint,
        existing: false,
      },
    };
  });
  tx();
  // result is always set inside the transaction; satisfy the compiler.
  return result ?? { ok: false, error: "invalid" };
}

/**
 * Delete a watch (alerts cascade). Wrong id and wrong secret are
 * indistinguishable: both return false.
 */
export function deleteWatch(id: number, secret: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT secret FROM watched_queries WHERE id = ?")
    .get(id) as { secret: string } | undefined;
  if (!secretMatches(row?.secret, secret)) return false;
  db.prepare("DELETE FROM watched_queries WHERE id = ?").run(id);
  markWatchCacheDirty();
  return true;
}

/**
 * Alerts for up to 10 {id, secret} pairs. Pairs with a wrong id or secret are
 * silently omitted. Bumps last_read_at on every watch it returns.
 */
export function getAlertsForWatches(
  pairs: { id: number; secret: string }[],
  sinceMs?: number
): WatchWithAlerts[] {
  const capped = pairs.slice(0, MAX_ALERT_PAIRS);
  const out: WatchWithAlerts[] = [];
  if (capped.length === 0) return out;
  const db = getDb();
  const watchStmt = db.prepare(
    `SELECT id, kind, display_query, secret, telegram_chat_id
     FROM watched_queries WHERE id = ?`
  );
  const alertsStmt = db.prepare(
    `SELECT id, kind, mint, name, symbol, source, payload, matched_at
     FROM alerts WHERE watch_id = ? AND matched_at > ?
     ORDER BY matched_at DESC, id DESC LIMIT ${MAX_ALERTS_PER_WATCH}`
  );
  const readStmt = db.prepare(
    "UPDATE watched_queries SET last_read_at = ? WHERE id = ?"
  );
  const now = Date.now();
  const since =
    typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;
  for (const pair of capped) {
    if (!Number.isInteger(pair.id) || pair.id <= 0) continue;
    const row = watchStmt.get(pair.id) as
      | {
          id: number;
          kind: WatchKind;
          display_query: string;
          secret: string;
          telegram_chat_id: string | null;
        }
      | undefined;
    if (!row || !secretMatches(row.secret, pair.secret)) continue;
    const alerts = (
      alertsStmt.all(pair.id, since) as {
        id: number;
        kind: "clone" | "flip";
        mint: string | null;
        name: string | null;
        symbol: string | null;
        source: string | null;
        payload: string | null;
        matched_at: number;
      }[]
    ).map((a) => {
      const alert: WatchAlertRow = {
        id: a.id,
        kind: a.kind,
        mint: a.mint,
        name: a.name,
        symbol: a.symbol,
        source: a.source,
        matchedAt: a.matched_at,
      };
      if (a.payload != null) {
        try {
          alert.payload = JSON.parse(a.payload);
        } catch {
          /* malformed payload — omit */
        }
      }
      return alert;
    });
    readStmt.run(now, pair.id);
    out.push({
      id: row.id,
      displayQuery: row.display_query,
      kind: row.kind,
      telegramLinked: row.telegram_chat_id != null,
      alerts,
    });
  }
  return out;
}

/**
 * Insert a kind='flip' alert for every watch whose query_skeleton equals
 * querySkeleton exactly, honoring the same daily cap as clone alerts. mint is
 * NULL so UNIQUE(watch_id, mint) never dedupes — each flip event is a fresh
 * row. `name` labels the row (challenger name); `payload` is stored as JSON.
 * Never throws — flip alerting is best-effort.
 */
export function recordFlipAlert(
  querySkeleton: string,
  info: { name: string | null; payload: unknown }
): void {
  try {
    const db = getDb();
    const watches = db
      .prepare("SELECT id FROM watched_queries WHERE query_skeleton = ?")
      .all(querySkeleton) as { id: number }[];
    if (watches.length === 0) return;
    const now = Date.now();
    const today = utcDay(now);
    const payloadJson = JSON.stringify(info.payload);
    const capStmt = db.prepare(
      "SELECT alert_day, alert_count_day FROM watched_queries WHERE id = ?"
    );
    const insertStmt = db.prepare(
      `INSERT INTO alerts
         (watch_id, kind, mint, name, symbol, source, payload, matched_at)
       VALUES (?, 'flip', NULL, ?, NULL, 'snapshots', ?, ?)`
    );
    const bumpStmt = db.prepare(
      "UPDATE watched_queries SET alert_day = ?, alert_count_day = ? WHERE id = ?"
    );
    const tx = db.transaction(() => {
      for (const w of watches) {
        const row = capStmt.get(w.id) as
          | { alert_day: string | null; alert_count_day: number }
          | undefined;
        if (!row) continue;
        const count = row.alert_day === today ? row.alert_count_day : 0;
        if (count >= DAILY_ALERT_CAP) continue;
        insertStmt.run(w.id, info.name, payloadJson, now);
        bumpStmt.run(today, count + 1, w.id);
      }
    });
    tx();
  } catch {
    /* alerting is best-effort */
  }
}

interface CachedWatch {
  id: number;
  querySkeleton: string;
  matchMode: WatchMatchMode;
  originMint: string | null;
}

// Watch rows change rarely (create/delete only) — cache them in-process and
// reload at most once per poller tick, only after a mutation set the flag.
let watchCache: CachedWatch[] = [];
let watchCacheDirty = true;

function markWatchCacheDirty(): void {
  watchCacheDirty = true;
}

/**
 * Match one tick's discoveries against all watches and insert `clone` alerts.
 * Skips skeleton-less discoveries, tokens with a known pair age over 72h, and
 * a mint-cluster watch's own origin mint. Per-watch daily cap of 25; the
 * UNIQUE(watch_id, mint) constraint dedupes cross-source rediscoveries.
 * Never throws — alerting must not kill a poller tick.
 */
export function matchDiscoveriesAgainstWatches(
  discoveries: NewDiscovery[]
): void {
  try {
    if (discoveries.length === 0) return;
    const db = getDb();
    if (watchCacheDirty) {
      watchCache = (
        db
          .prepare(
            "SELECT id, query_skeleton, match_mode, origin_mint FROM watched_queries"
          )
          .all() as {
          id: number;
          query_skeleton: string;
          match_mode: WatchMatchMode;
          origin_mint: string | null;
        }[]
      ).map((r) => ({
        id: r.id,
        querySkeleton: r.query_skeleton,
        matchMode: r.match_mode,
        originMint: r.origin_mint,
      }));
      watchCacheDirty = false;
    }
    if (watchCache.length === 0) return;

    const now = Date.now();
    const alertable = discoveries.filter(
      (d) =>
        d.nameSkeleton !== null &&
        !(
          d.pairCreatedAtMs != null &&
          now - d.pairCreatedAtMs > ALERT_MAX_TOKEN_AGE_MS
        )
    );
    if (alertable.length === 0) return;

    // Pure matching pass first; DB writes happen in one bounded transaction.
    const matches: { watchId: number; d: NewDiscovery }[] = [];
    for (const w of watchCache) {
      for (const d of alertable) {
        const s = d.nameSkeleton as string;
        const hit =
          w.matchMode === "exact"
            ? s === w.querySkeleton
            : s.includes(w.querySkeleton);
        if (!hit) continue;
        if (w.originMint !== null && w.originMint === d.mint) continue;
        matches.push({ watchId: w.id, d });
      }
    }
    if (matches.length === 0) return;

    const today = utcDay(now);
    const capStmt = db.prepare(
      "SELECT alert_day, alert_count_day FROM watched_queries WHERE id = ?"
    );
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO alerts
         (watch_id, kind, mint, name, symbol, source, payload, matched_at)
       VALUES (?, 'clone', ?, ?, ?, ?, ?, ?)`
    );
    const bumpStmt = db.prepare(
      "UPDATE watched_queries SET alert_day = ?, alert_count_day = ? WHERE id = ?"
    );
    const tx = db.transaction(() => {
      // Today's count per watch, loaded lazily inside the txn so the daily
      // cap stays consistent with the rows we insert.
      const counts = new Map<number, number>();
      for (const { watchId, d } of matches) {
        let count = counts.get(watchId);
        if (count === undefined) {
          const row = capStmt.get(watchId) as
            | { alert_day: string | null; alert_count_day: number }
            | undefined;
          if (!row) {
            // Watch deleted since the cache loaded — never insert (FK).
            counts.set(watchId, DAILY_ALERT_CAP);
            continue;
          }
          count = row.alert_day === today ? row.alert_count_day : 0;
        }
        if (count >= DAILY_ALERT_CAP) {
          counts.set(watchId, count);
          continue;
        }
        const payload =
          d.pairCreatedAtMs != null
            ? JSON.stringify({ pairCreatedAtMs: d.pairCreatedAtMs })
            : null;
        const info = insertStmt.run(
          watchId,
          d.mint,
          d.name,
          d.symbol,
          d.source,
          payload,
          now
        );
        if (info.changes > 0) {
          count += 1;
          bumpStmt.run(today, count, watchId);
        }
        counts.set(watchId, count);
      }
    });
    tx();
  } catch {
    /* alerting is best-effort — never kills a tick */
  }
}
