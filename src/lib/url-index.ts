import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { normalizeForSocialMatch } from "./social-url";

const DB_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DB_DIR, "url-index.sqlite");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
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
  `);
  return db;
}

let upsertStmt: Database.Statement | null = null;

function getUpsertStmt(): Database.Statement {
  if (!upsertStmt) {
    upsertStmt = getDb().prepare(`
      INSERT OR IGNORE INTO token_links (mint, url_norm, url_raw, source, discovered_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  }
  return upsertStmt;
}

export function upsertTokenLinks(
  mint: string,
  urls: string[],
  source: string
): void {
  const now = Date.now();
  const stmt = getUpsertStmt();
  const tx = getDb().transaction(() => {
    for (const raw of urls) {
      const norm = normalizeForSocialMatch(raw);
      if (!norm || norm.length < 3) continue;
      // Bare host (e.g. x.com) matches every x.com/... URL in search — skip.
      if (!norm.includes("/")) continue;
      stmt.run(mint, norm, raw, source, now);
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
      `SELECT DISTINCT mint FROM token_links
       WHERE url_norm = ?
          OR url_norm LIKE ? ESCAPE '\\'
          OR (substr(?, 1, length(url_norm) + 1) = url_norm || '/'
              AND url_norm LIKE '%/%')
       LIMIT 500`
    );
  }
  return searchStmt;
}

export function searchByUrl(targetNorms: string[]): string[] {
  if (targetNorms.length === 0) return [];
  const mints = new Set<string>();

  const stmt = getSearchStmt();

  for (const t of targetNorms) {
    if (!t || t.length < 3) continue;
    const patExtendsTarget = `${escapeSqlLike(t)}/%`;
    const rows = stmt.all(t, patExtendsTarget, t) as { mint: string }[];
    for (const r of rows) mints.add(r.mint);
  }

  return Array.from(mints);
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
