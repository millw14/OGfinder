import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { normalizeForSocialMatch } from "./social-url";

const DB_DIR = path.join(process.cwd(), ".data");
/** Overridable for tests (":memory:" supported). */
const DB_PATH =
  process.env.OGFINDER_DB_PATH?.trim() || path.join(DB_DIR, "url-index.sqlite");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  if (DB_PATH !== ":memory:") fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_links (
      mint       TEXT    NOT NULL,
      url_norm   TEXT    NOT NULL,
      url_raw    TEXT    NOT NULL,
      source     TEXT    NOT NULL DEFAULT 'unknown',
      discovered_at INTEGER NOT NULL,
      UNIQUE(mint, url_norm)
    );
    CREATE INDEX IF NOT EXISTS idx_token_links_url ON token_links(url_norm);
    CREATE TABLE IF NOT EXISTS poll_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discovered_tokens (
      mint            TEXT    PRIMARY KEY,
      name            TEXT,
      symbol          TEXT,
      name_skeleton   TEXT,
      source          TEXT    NOT NULL,
      first_seen_at   INTEGER NOT NULL,
      named_at        INTEGER,
      pair_created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_discovered_skeleton ON discovered_tokens(name_skeleton, first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_discovered_first_seen ON discovered_tokens(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_discovered_unnamed ON discovered_tokens(first_seen_at) WHERE name IS NULL;
  `);
  // Migration: token_links freshness columns (ALTER TABLE has no IF NOT EXISTS).
  // Runs before any statement is prepared — all stmt singletons lazily call
  // getDb() first, so they always see the migrated schema.
  const cols = new Set(
    (db.pragma("table_info(token_links)") as { name: string }[]).map(
      (c) => c.name
    )
  );
  if (!cols.has("last_seen_at")) {
    db.exec("ALTER TABLE token_links ADD COLUMN last_seen_at INTEGER");
  }
  if (!cols.has("last_verified_at")) {
    db.exec("ALTER TABLE token_links ADD COLUMN last_verified_at INTEGER");
  }
  db.exec(`
    UPDATE token_links SET last_seen_at = discovered_at WHERE last_seen_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_token_links_last_seen ON token_links(last_seen_at);
  `);
  return db;
}

let upsertStmt: Database.Statement | null = null;

function getUpsertStmt(): Database.Statement {
  if (!upsertStmt) {
    // discovered_at + source keep their first-seen values on conflict.
    upsertStmt = getDb().prepare(`
      INSERT INTO token_links (mint, url_norm, url_raw, source, discovered_at, last_seen_at, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint, url_norm) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        url_raw = excluded.url_raw,
        last_verified_at = COALESCE(excluded.last_verified_at, token_links.last_verified_at)
    `);
  }
  return upsertStmt;
}

export function upsertTokenLinks(
  mint: string,
  urls: string[],
  source: string,
  opts?: { verified?: boolean }
): void {
  const now = Date.now();
  const verifiedAt = opts?.verified ? now : null;
  const stmt = getUpsertStmt();
  const tx = getDb().transaction(() => {
    for (const raw of urls) {
      const norm = normalizeForSocialMatch(raw);
      if (!norm || norm.length < 3) continue;
      // Bare host (e.g. x.com) matches every x.com/... URL in search — skip.
      if (!norm.includes("/")) continue;
      stmt.run(mint, norm, raw, source, now, now, verifiedAt);
    }
  });
  tx();
}

/** Escape % and _ for SQL LIKE with ESCAPE '\\'. */
function escapeSqlLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Find mints whose stored URLs path-prefix-match any normalized target.
 * Avoids bare-host false positives (e.g. x.com matching every community URL).
 */
let searchStmt: Database.Statement | null = null;

function getSearchStmt(): Database.Statement {
  if (!searchStmt) {
    // Reverse prefix check uses substr/length instead of LIKE so stored
    // url_norm values containing % or _ can't act as wildcard patterns.
    searchStmt = getDb().prepare(
      `SELECT mint, MAX(last_verified_at) AS last_verified_at FROM token_links
       WHERE url_norm = ?
          OR url_norm LIKE ? ESCAPE '\\'
          OR (substr(?, 1, length(url_norm) + 1) = url_norm || '/'
              AND url_norm LIKE '%/%')
       GROUP BY mint
       LIMIT 500`
    );
  }
  return searchStmt;
}

export interface UrlIndexHit {
  mint: string;
  /** Most recent live link verification (ms), or null if never verified. */
  lastVerifiedAt: number | null;
}

export function searchByUrlDetailed(targetNorms: string[]): UrlIndexHit[] {
  if (targetNorms.length === 0) return [];
  const byMint = new Map<string, number | null>();

  const stmt = getSearchStmt();

  for (const t of targetNorms) {
    if (!t || t.length < 3) continue;
    const patExtendsTarget = `${escapeSqlLike(t)}/%`;
    const rows = stmt.all(t, patExtendsTarget, t) as {
      mint: string;
      last_verified_at: number | null;
    }[];
    for (const r of rows) {
      const prev = byMint.get(r.mint);
      // Keep the freshest verification time across matching targets.
      if (prev === undefined || (r.last_verified_at ?? 0) > (prev ?? 0)) {
        byMint.set(r.mint, r.last_verified_at ?? null);
      }
    }
  }

  return Array.from(byMint, ([mint, lastVerifiedAt]) => ({
    mint,
    lastVerifiedAt,
  }));
}

export function searchByUrl(targetNorms: string[]): string[] {
  return searchByUrlDetailed(targetNorms).map((h) => h.mint);
}

export interface MintLinkRow {
  mint: string;
  url_norm: string;
  /** When OUR poller first saw this link — NOT when the link was created. */
  discovered_at: number;
}

/** Max mints per getLinksForMints call (placeholder count stays bounded). */
const LINKS_FOR_MINTS_CAP = 30;

/**
 * All indexed links for the given mints (first 30 mints, max 500 rows).
 * Failures return [] — provenance is best-effort and must never break a scan.
 */
export function getLinksForMints(mints: string[]): MintLinkRow[] {
  const capped = mints.slice(0, LINKS_FOR_MINTS_CAP);
  if (capped.length === 0) return [];
  try {
    const placeholders = capped.map(() => "?").join(",");
    return getDb()
      .prepare(
        `SELECT mint, url_norm, discovered_at FROM token_links
         WHERE mint IN (${placeholders})
         LIMIT 500`
      )
      .all(...capped) as MintLinkRow[];
  } catch {
    return [];
  }
}

export function countIndexedTokens(): number {
  const row = getDb()
    .prepare("SELECT COUNT(DISTINCT mint) as cnt FROM token_links")
    .get() as { cnt: number };
  return row?.cnt ?? 0;
}

export function getPollState(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM poll_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setPollState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO poll_state (key, value) VALUES (?, ?)"
    )
    .run(key, value);
}
