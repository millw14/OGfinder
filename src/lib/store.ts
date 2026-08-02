import Database from "better-sqlite3";
import { getDb } from "./url-index";

/**
 * SQLite persistence layer (L2) behind the in-memory caches:
 *  - creation_slots: immutable creation slot/blockTime facts per mint
 *  - search_cache:   full search responses with an absolute expiry
 * Plus periodic hygiene (expired rows, stale token_links, WAL checkpoint).
 *
 * Every export is synchronous and swallows SQLite failures — callers degrade
 * to in-memory-only behavior, never 500.
 */

/** Days of inactivity before unverified token_links rows are pruned. */
const PRUNE_DAYS = (() => {
  const raw = Number(process.env.TOKEN_LINKS_PRUNE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
})();

const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;

let schemaReady = false;

function ensureStoreSchema(): void {
  if (schemaReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS creation_slots (
      mint              TEXT    PRIMARY KEY,
      slot              INTEGER NOT NULL,
      block_time        INTEGER NOT NULL,
      verified_complete INTEGER NOT NULL DEFAULT 1,
      updated_at        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_cache (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);
    CREATE TABLE IF NOT EXISTS deployer_profiles (
      deployer            TEXT PRIMARY KEY,
      tokens_created      INTEGER,
      wallet_first_seen_ms INTEGER,
      is_old_wallet       INTEGER NOT NULL DEFAULT 0,
      checked_at          INTEGER NOT NULL
    );
  `);
  // Migration: creation_slots.deployer (ALTER TABLE has no IF NOT EXISTS) —
  // same guarded pattern as url-index's token_links columns.
  const csCols = new Set(
    (db.pragma("table_info(creation_slots)") as { name: string }[]).map(
      (c) => c.name
    )
  );
  if (!csCols.has("deployer")) {
    db.exec("ALTER TABLE creation_slots ADD COLUMN deployer TEXT");
  }
  schemaReady = true;
  // One checkpoint at init — the WAL can grow large between restarts.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* busy — next maintenanceTick retries */
  }
}

let getSlotStmt: Database.Statement | null = null;
let setSlotStmt: Database.Statement | null = null;
let getSearchStmt: Database.Statement | null = null;
let delSearchStmt: Database.Statement | null = null;
let setSearchStmt: Database.Statement | null = null;

/** Only complete scans (verified_complete=1) count — block_time is unix SECONDS. */
export function getCreationSlotPersisted(
  mint: string
): { slot: number; blockTime: number } | undefined {
  try {
    ensureStoreSchema();
    if (!getSlotStmt) {
      getSlotStmt = getDb().prepare(
        "SELECT slot, block_time FROM creation_slots WHERE mint = ? AND verified_complete = 1"
      );
    }
    const row = getSlotStmt.get(mint) as
      | { slot: number; block_time: number }
      | undefined;
    if (!row) return undefined;
    return { slot: row.slot, blockTime: row.block_time };
  } catch {
    return undefined;
  }
}

export function setCreationSlotPersisted(
  mint: string,
  data: { slot: number; blockTime: number },
  verifiedComplete: boolean = true
): void {
  try {
    ensureStoreSchema();
    if (!setSlotStmt) {
      setSlotStmt = getDb().prepare(`
        INSERT OR REPLACE INTO creation_slots (mint, slot, block_time, verified_complete, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
    }
    setSlotStmt.run(
      mint,
      data.slot,
      data.blockTime,
      verifiedComplete ? 1 : 0,
      Date.now()
    );
  } catch {
    /* persistence is best-effort */
  }
}

/** Delete-on-read when expired. expiresAtMs lets callers rebuild remaining TTL. */
export function getSearchCachePersisted<T>(
  key: string
): { value: T; expiresAtMs: number } | undefined {
  try {
    ensureStoreSchema();
    if (!getSearchStmt) {
      getSearchStmt = getDb().prepare(
        "SELECT json, expires_at FROM search_cache WHERE key = ?"
      );
    }
    const row = getSearchStmt.get(key) as
      | { json: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      if (!delSearchStmt) {
        delSearchStmt = getDb().prepare(
          "DELETE FROM search_cache WHERE key = ?"
        );
      }
      delSearchStmt.run(key);
      return undefined;
    }
    return { value: JSON.parse(row.json) as T, expiresAtMs: row.expires_at };
  } catch {
    return undefined;
  }
}

export function setSearchCachePersisted<T>(
  key: string,
  value: T,
  expiresAtMs: number
): void {
  try {
    ensureStoreSchema();
    if (!setSearchStmt) {
      setSearchStmt = getDb().prepare(`
        INSERT OR REPLACE INTO search_cache (key, json, expires_at)
        VALUES (?, ?, ?)
      `);
    }
    setSearchStmt.run(key, JSON.stringify(value), expiresAtMs);
  } catch {
    /* persistence is best-effort */
  }
}

// ————————————————— Deployer intelligence persistence —————————————————

let getDeployerStmt: Database.Statement | null = null;
let setDeployerStmt: Database.Statement | null = null;
let getProfileStmt: Database.Statement | null = null;
let setProfileStmt: Database.Statement | null = null;

/** Persisted deployer wallet for a mint (creation_slots.deployer), if resolved. */
export function getDeployerPersisted(mint: string): string | undefined {
  try {
    ensureStoreSchema();
    if (!getDeployerStmt) {
      getDeployerStmt = getDb().prepare(
        "SELECT deployer FROM creation_slots WHERE mint = ?"
      );
    }
    const row = getDeployerStmt.get(mint) as
      | { deployer: string | null }
      | undefined;
    return row?.deployer ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a resolved deployer. Upserts into creation_slots: an existing row
 * (complete creation scan) only gains the deployer column; a fresh insert
 * carries the slot/blockTime we just found — marked verified_complete only
 * when the blockTime is a real timestamp, so getCreationSlotPersisted never
 * serves a zero blockTime.
 */
export function setDeployerPersisted(
  mint: string,
  deployer: string,
  slotData: { slot: number; blockTime: number }
): void {
  try {
    ensureStoreSchema();
    if (!setDeployerStmt) {
      setDeployerStmt = getDb().prepare(`
        INSERT INTO creation_slots (mint, slot, block_time, verified_complete, updated_at, deployer)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          deployer   = excluded.deployer,
          updated_at = excluded.updated_at
      `);
    }
    setDeployerStmt.run(
      mint,
      slotData.slot,
      slotData.blockTime,
      slotData.blockTime > 0 ? 1 : 0,
      Date.now(),
      deployer
    );
  } catch {
    /* persistence is best-effort */
  }
}

/** Persisted profile of a deployer wallet — freshness is the CALLER's job. */
export interface DeployerProfileRow {
  tokensCreated: number | null;
  walletFirstSeenMs: number | null;
  isOldWallet: boolean;
  checkedAt: number;
}

export function getDeployerProfilePersisted(
  deployer: string
): DeployerProfileRow | undefined {
  try {
    ensureStoreSchema();
    if (!getProfileStmt) {
      getProfileStmt = getDb().prepare(
        `SELECT tokens_created, wallet_first_seen_ms, is_old_wallet, checked_at
         FROM deployer_profiles WHERE deployer = ?`
      );
    }
    const row = getProfileStmt.get(deployer) as
      | {
          tokens_created: number | null;
          wallet_first_seen_ms: number | null;
          is_old_wallet: number;
          checked_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      tokensCreated: row.tokens_created,
      walletFirstSeenMs: row.wallet_first_seen_ms,
      isOldWallet: row.is_old_wallet === 1,
      checkedAt: row.checked_at,
    };
  } catch {
    return undefined;
  }
}

export function setDeployerProfilePersisted(
  deployer: string,
  p: DeployerProfileRow
): void {
  try {
    ensureStoreSchema();
    if (!setProfileStmt) {
      setProfileStmt = getDb().prepare(`
        INSERT OR REPLACE INTO deployer_profiles
          (deployer, tokens_created, wallet_first_seen_ms, is_old_wallet, checked_at)
        VALUES (?, ?, ?, ?, ?)
      `);
    }
    setProfileStmt.run(
      deployer,
      p.tokensCreated,
      p.walletFirstSeenMs,
      p.isOldWallet ? 1 : 0,
      p.checkedAt
    );
  } catch {
    /* persistence is best-effort */
  }
}

let lastMaintenanceAt = 0;

/**
 * Periodic hygiene, self-gated to once per 30 minutes: drop expired search_cache
 * rows, prune token_links neither seen nor verified within PRUNE_DAYS, and
 * truncate the WAL. Safe to call from any hot path.
 */
export function maintenanceTick(now: number = Date.now()): void {
  try {
    if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    lastMaintenanceAt = now;
    ensureStoreSchema();
    const db = getDb();
    db.prepare("DELETE FROM search_cache WHERE expires_at <= ?").run(now);
    const cutoff = now - PRUNE_DAYS * 24 * 60 * 60 * 1000;
    db.prepare(
      `DELETE FROM token_links
       WHERE COALESCE(last_seen_at, discovered_at) < ?
         AND COALESCE(last_verified_at, 0) < ?`
    ).run(cutoff, cutoff);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* maintenance is best-effort */
  }
}
