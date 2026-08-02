import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

/**
 * Bot persistence: per-chat settings, watchlists, and scan stats.
 * Lives in .data/bot.sqlite (mount a Railway volume at /app/.data to keep it
 * across deploys). Falls back to an in-memory DB if the disk is read-only so
 * the bot never refuses to boot over storage.
 */

export interface ChatSettings {
  autoscan: boolean;
  /** Quiet mode: auto-scan replies only when the CA is NOT the OG. */
  quiet: boolean;
}

export interface WatchRow {
  chat_id: number;
  mint: string;
  symbol: string | null;
  added_by: number;
  added_at: number;
  last_price: number | null;
  last_liq: number | null;
  last_alert_at: number | null;
}

export interface ChatStats {
  scans: number;
  ogCount: number;
  topMints: { mint: string; name: string | null; count: number }[];
}

export const MAX_WATCHES_PER_CHAT = 10;

const DEFAULT_SETTINGS: ChatSettings = { autoscan: true, quiet: false };

export class BotStore {
  private db: Database.Database;
  readonly inMemory: boolean;

  constructor(dbPath?: string) {
    let db: Database.Database;
    let inMemory = false;
    const target =
      dbPath && dbPath.length > 0
        ? dbPath
        : path.join(process.cwd(), ".data", "bot.sqlite");
    try {
      if (target !== ":memory:") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
      db = new Database(target);
    } catch (err) {
      console.warn(
        `[bot] could not open sqlite at ${target} (${(err as Error).message}) — using in-memory store`
      );
      db = new Database(":memory:");
      inMemory = true;
    }
    this.inMemory = inMemory || target === ":memory:";
    this.db = db;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id    INTEGER PRIMARY KEY,
        autoscan   INTEGER NOT NULL DEFAULT 1,
        quiet      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watches (
        chat_id       INTEGER NOT NULL,
        mint          TEXT    NOT NULL,
        symbol        TEXT,
        added_by      INTEGER NOT NULL,
        added_at      INTEGER NOT NULL,
        last_price    REAL,
        last_liq      REAL,
        last_alert_at INTEGER,
        PRIMARY KEY (chat_id, mint)
      );
      CREATE TABLE IF NOT EXISTS scans (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        mint    TEXT    NOT NULL,
        name    TEXT,
        is_og   INTEGER NOT NULL,
        rank    INTEGER,
        total   INTEGER,
        at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scans_chat ON scans(chat_id, at);
      CREATE INDEX IF NOT EXISTS idx_watches_mint ON watches(mint);
    `);
  }

  getChatSettings(chatId: number): ChatSettings {
    const row = this.db
      .prepare("SELECT autoscan, quiet FROM chat_settings WHERE chat_id = ?")
      .get(chatId) as { autoscan: number; quiet: number } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    return { autoscan: row.autoscan === 1, quiet: row.quiet === 1 };
  }

  setChatSetting(
    chatId: number,
    key: keyof ChatSettings,
    value: boolean
  ): ChatSettings {
    const current = this.getChatSettings(chatId);
    const next = { ...current, [key]: value };
    this.db
      .prepare(
        `INSERT INTO chat_settings (chat_id, autoscan, quiet, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           autoscan = excluded.autoscan,
           quiet = excluded.quiet,
           updated_at = excluded.updated_at`
      )
      .run(chatId, next.autoscan ? 1 : 0, next.quiet ? 1 : 0, Date.now());
    return next;
  }

  addWatch(
    chatId: number,
    mint: string,
    symbol: string | null,
    addedBy: number,
    price: number | null,
    liq: number | null
  ): "added" | "exists" | "full" {
    const count = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM watches WHERE chat_id = ?")
        .get(chatId) as { c: number }
    ).c;
    const exists = this.db
      .prepare("SELECT 1 FROM watches WHERE chat_id = ? AND mint = ?")
      .get(chatId, mint);
    if (exists) return "exists";
    if (count >= MAX_WATCHES_PER_CHAT) return "full";
    this.db
      .prepare(
        `INSERT INTO watches
           (chat_id, mint, symbol, added_by, added_at, last_price, last_liq, last_alert_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(chatId, mint, symbol, addedBy, Date.now(), price, liq);
    return "added";
  }

  removeWatch(chatId: number, mint: string): boolean {
    const res = this.db
      .prepare("DELETE FROM watches WHERE chat_id = ? AND mint = ?")
      .run(chatId, mint);
    return res.changes > 0;
  }

  listWatches(chatId: number): WatchRow[] {
    return this.db
      .prepare("SELECT * FROM watches WHERE chat_id = ? ORDER BY added_at")
      .all(chatId) as WatchRow[];
  }

  allWatches(): WatchRow[] {
    return this.db.prepare("SELECT * FROM watches").all() as WatchRow[];
  }

  updateWatchSnapshot(
    chatId: number,
    mint: string,
    price: number | null,
    liq: number | null,
    alerted: boolean
  ): void {
    if (alerted) {
      this.db
        .prepare(
          `UPDATE watches SET last_price = ?, last_liq = ?, last_alert_at = ?
           WHERE chat_id = ? AND mint = ?`
        )
        .run(price, liq, Date.now(), chatId, mint);
    } else {
      this.db
        .prepare(
          `UPDATE watches SET last_price = ?, last_liq = ?
           WHERE chat_id = ? AND mint = ?`
        )
        .run(price, liq, chatId, mint);
    }
  }

  recordScan(
    chatId: number,
    mint: string,
    name: string | null,
    isOg: boolean,
    rank: number | null,
    total: number | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO scans (chat_id, mint, name, is_og, rank, total, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(chatId, mint, name, isOg ? 1 : 0, rank, total, Date.now());
  }

  chatStats(chatId: number): ChatStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS scans, COALESCE(SUM(is_og), 0) AS ogs
         FROM scans WHERE chat_id = ?`
      )
      .get(chatId) as { scans: number; ogs: number };
    const top = this.db
      .prepare(
        `SELECT mint, name, COUNT(*) AS count FROM scans
         WHERE chat_id = ? GROUP BY mint ORDER BY count DESC, MAX(at) DESC LIMIT 3`
      )
      .all(chatId) as { mint: string; name: string | null; count: number }[];
    return {
      scans: totals.scans,
      ogCount: totals.ogs,
      topMints: top,
    };
  }

  /** Telegram upgraded a group to a supergroup — carry state to the new id. */
  migrateChat(oldId: number, newId: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE OR IGNORE chat_settings SET chat_id = ? WHERE chat_id = ?"
        )
        .run(newId, oldId);
      this.db
        .prepare("UPDATE OR IGNORE watches SET chat_id = ? WHERE chat_id = ?")
        .run(newId, oldId);
      this.db
        .prepare("UPDATE scans SET chat_id = ? WHERE chat_id = ?")
        .run(newId, oldId);
    });
    tx();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
