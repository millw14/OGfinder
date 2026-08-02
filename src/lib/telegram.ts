import crypto from "crypto";
import { getDb, getPollState, setPollState } from "./url-index";
import { fetchWithTimeout, FetchError } from "./fetch";

/**
 * Telegram alert delivery, fully env-gated: without TELEGRAM_BOT_TOKEN every
 * export early-returns (null / no-op) and the app behaves exactly as before.
 * Raw Bot API calls (getMe/getUpdates/sendMessage) via fetchWithTimeout — no
 * SDK. Linking is deep-link based: /start w_<id>_<secret> proves watch
 * ownership (the watch secret is the only credential), so no accounts here
 * either. processTelegramUpdates + sendPendingTelegramAlerts run inside the
 * poller tick and swallow all failures — they must never kill a tick.
 */

const TG_API = "https://api.telegram.org";
const TG_TIMEOUT = 10_000;
/** Max updates consumed per tick (getUpdates limit). */
const UPDATES_PER_TICK = 50;
/** Max alert sendMessage calls per tick. */
const SENDS_PER_TICK = 20;
/** Throttle failed getMe retries — telegramLinkUrl runs on request paths. */
const GETME_RETRY_MS = 60_000;

function botToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

export function isTelegramEnabled(): boolean {
  return !!botToken();
}

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") ||
    "http://localhost:3400"
  );
}

async function tgCall(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const token = botToken();
  if (!token) return null;
  // POST keeps the token out of retry loops (fetchWithTimeout retries GET only)
  // and FetchError messages never include the URL.
  return fetchWithTimeout(`${TG_API}/bot${token}/${method}`, TG_TIMEOUT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

let cachedUsername: string | null = null;
let lastGetMeFailMs = 0;

/**
 * Bot username for deep links: TELEGRAM_BOT_USERNAME env if set, else getMe
 * once, cached in-process and in poll_state 'tg:bot_username'. Never throws.
 */
export async function getBotUsername(): Promise<string | null> {
  if (!isTelegramEnabled()) return null;
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (fromEnv) return fromEnv;
  if (cachedUsername) return cachedUsername;
  try {
    const stored = getPollState("tg:bot_username");
    if (stored) {
      cachedUsername = stored;
      return stored;
    }
  } catch {
    /* poll_state unavailable — fall through to getMe */
  }
  if (Date.now() - lastGetMeFailMs < GETME_RETRY_MS) return null;
  try {
    const res = (await tgCall("getMe", {})) as {
      ok?: boolean;
      result?: { username?: string };
    } | null;
    const username = res?.ok ? res.result?.username : undefined;
    if (!username) {
      lastGetMeFailMs = Date.now();
      return null;
    }
    cachedUsername = username;
    try {
      setPollState("tg:bot_username", username);
    } catch {
      /* cache is best-effort */
    }
    return username;
  } catch {
    lastGetMeFailMs = Date.now();
    return null;
  }
}

/**
 * Deep link that connects a watch to a Telegram chat via /start. The payload
 * w_<id>_<32hex> stays well under Telegram's 64-char start limit. Null when
 * Telegram is disabled or the bot username can't be resolved. Never throws.
 */
export async function telegramLinkUrl(
  watchId: number,
  secret: string
): Promise<string | null> {
  if (!isTelegramEnabled()) return null;
  const username = await getBotUsername();
  if (!username) return null;
  return `https://t.me/${username}?start=w_${watchId}_${secret}`;
}

const START_PAYLOAD_RE = /^w_([1-9]\d{0,9})_([0-9a-f]{32})$/;

/** Parse a /start deep-link payload (w_<id>_<32hex>); invalid → null. */
export function parseStartPayload(
  payload: string
): { watchId: number; secret: string } | null {
  const m = START_PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return { watchId: Number(m[1]), secret: m[2] };
}

export interface TelegramCommand {
  command: "start" | "stop" | "list";
  arg: string | null;
}

/** Parse "/cmd[@BotName] [arg]" message text; non-commands return null. */
export function parseTelegramCommand(text: string): TelegramCommand | null {
  const m = /^\/(start|stop|list)(?:@\S+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  return { command: m[1] as TelegramCommand["command"], arg: m[2] ?? null };
}

/** Telegram HTML parse mode requires escaping only &, <, >. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AlertMessageInput {
  displayQuery: string;
  name: string | null;
  symbol: string | null;
  source: string | null;
  mint: string | null;
  /** Parsed alert payload JSON, when present and valid. */
  payload?: unknown;
}

/** Clone alert body (Telegram HTML parse mode). */
export function formatCloneAlertMessage(
  a: AlertMessageInput,
  site: string
): string {
  const name = escapeHtml(a.name ?? "Unnamed token");
  let head = `🚨 New clone of "${escapeHtml(a.displayQuery)}": <b>${name}</b>`;
  if (a.symbol) head += ` ($${escapeHtml(a.symbol)})`;
  if (a.source) head += ` via ${escapeHtml(a.source)}`;
  const lines = [head];
  if (a.mint) {
    lines.push(`${site}/?q=${encodeURIComponent(a.mint)}`);
    lines.push(`https://dexscreener.com/solana/${encodeURIComponent(a.mint)}`);
  }
  return lines.join("\n");
}

/**
 * Flip alert body. Flip rows (NULL mint allowed) carry their context in the
 * payload JSON — render a payload `message` string when present.
 */
export function formatFlipAlertMessage(
  a: AlertMessageInput,
  site: string
): string {
  const p =
    typeof a.payload === "object" && a.payload !== null
      ? (a.payload as Record<string, unknown>)
      : {};
  let head = `🔁 Watch update for "${escapeHtml(a.displayQuery)}"`;
  if (a.name) head += `: <b>${escapeHtml(a.name)}</b>`;
  if (a.symbol) head += ` ($${escapeHtml(a.symbol)})`;
  const lines = [head];
  if (typeof p.message === "string" && p.message) {
    lines.push(escapeHtml(p.message));
  }
  if (a.mint) {
    lines.push(`${site}/?q=${encodeURIComponent(a.mint)}`);
  }
  return lines.join("\n");
}

/** Constant-time secret check; length mismatch and missing row both fail. */
function secretMatches(stored: string | undefined, provided: string): boolean {
  const a = Buffer.from(stored ?? "", "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch {
    /* confirmations are best-effort */
  }
}

async function handleStart(chatId: string, arg: string | null): Promise<void> {
  const parsed = arg ? parseStartPayload(arg) : null;
  if (!parsed) {
    await reply(
      chatId,
      'Hi! Link a watch from the OGfinder site — the "Get Telegram alerts" button opens this chat with the right code.'
    );
    return;
  }
  const db = getDb();
  const row = db
    .prepare("SELECT secret, display_query FROM watched_queries WHERE id = ?")
    .get(parsed.watchId) as
    | { secret: string; display_query: string }
    | undefined;
  if (!row || !secretMatches(row.secret, parsed.secret)) {
    await reply(
      chatId,
      "That link doesn't match an active watch — it may have been deleted. Re-create the watch on the site and try again."
    );
    return;
  }
  db.prepare(
    "UPDATE watched_queries SET telegram_chat_id = ? WHERE id = ?"
  ).run(chatId, parsed.watchId);
  await reply(
    chatId,
    `Linked — you'll get new-clone alerts for "${escapeHtml(row.display_query)}". Send /stop to unlink.`
  );
}

async function handleStop(chatId: string): Promise<void> {
  const info = getDb()
    .prepare(
      "UPDATE watched_queries SET telegram_chat_id = NULL WHERE telegram_chat_id = ?"
    )
    .run(chatId);
  await reply(
    chatId,
    info.changes > 0
      ? `Unlinked ${info.changes} watch${info.changes === 1 ? "" : "es"} — no more alerts in this chat.`
      : "No watches were linked to this chat."
  );
}

async function handleList(chatId: string): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT id, display_query, kind FROM watched_queries
       WHERE telegram_chat_id = ? ORDER BY id LIMIT 20`
    )
    .all(chatId) as { id: number; display_query: string; kind: string }[];
  if (rows.length === 0) {
    await reply(chatId, "No watches are linked to this chat.");
    return;
  }
  const lines = rows.map(
    (r) =>
      `• <b>${escapeHtml(r.display_query)}</b> (${
        r.kind === "mint-cluster" ? "clone-cluster" : "name"
      } watch)`
  );
  await reply(
    chatId,
    `Watches linked to this chat:\n${lines.join("\n")}\nSend /stop to unlink all.`
  );
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

/**
 * Drain pending bot commands (/start deep-links, /stop, /list) via getUpdates
 * with timeout=0 — never long-polls inside a tick. The offset lives in
 * poll_state 'tg:update_offset' and advances past every fetched update, even
 * ones whose handling failed, so a poison message can't wedge the queue.
 */
export async function processTelegramUpdates(): Promise<void> {
  if (!isTelegramEnabled()) return;
  try {
    let offset = 0;
    try {
      const stored = Number(getPollState("tg:update_offset"));
      if (Number.isFinite(stored) && stored > 0) offset = stored;
    } catch {
      /* poll_state unavailable — offset 0 */
    }
    const res = (await tgCall("getUpdates", {
      offset,
      limit: UPDATES_PER_TICK,
      timeout: 0,
    })) as { ok?: boolean; result?: TelegramUpdate[] } | null;
    if (!res?.ok || !Array.isArray(res.result) || res.result.length === 0) {
      return;
    }
    let maxUpdateId = offset - 1;
    for (const u of res.result) {
      if (typeof u.update_id === "number" && u.update_id > maxUpdateId) {
        maxUpdateId = u.update_id;
      }
      try {
        const chatIdRaw = u.message?.chat?.id;
        const text = u.message?.text;
        if (chatIdRaw == null || typeof text !== "string") continue;
        const chatId = String(chatIdRaw);
        const cmd = parseTelegramCommand(text);
        if (!cmd) continue;
        if (cmd.command === "start") await handleStart(chatId, cmd.arg);
        else if (cmd.command === "stop") await handleStop(chatId);
        else await handleList(chatId);
      } catch {
        /* one bad update must not stall the rest */
      }
    }
    try {
      setPollState("tg:update_offset", String(maxUpdateId + 1));
    } catch {
      /* poll_state is best-effort */
    }
  } catch {
    /* telegram is best-effort — never kills a tick */
  }
}

/**
 * Deliver undelivered alerts for Telegram-linked watches, oldest first, max
 * 20 per tick. Success and permanent 4xx (except 429) mark delivered; 403
 * additionally unlinks the watch's chat (bot blocked / chat gone); 429 stops
 * the batch for this tick; timeout/network/5xx leave the row for next tick.
 */
export async function sendPendingTelegramAlerts(): Promise<void> {
  if (!isTelegramEnabled()) return;
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT a.id, a.watch_id, a.kind, a.mint, a.name, a.symbol, a.source,
                a.payload, w.display_query, w.telegram_chat_id
         FROM alerts a
         JOIN watched_queries w ON w.id = a.watch_id
         WHERE a.delivered_telegram = 0 AND w.telegram_chat_id IS NOT NULL
         ORDER BY a.id
         LIMIT ${SENDS_PER_TICK}`
      )
      .all() as {
      id: number;
      watch_id: number;
      kind: "clone" | "flip";
      mint: string | null;
      name: string | null;
      symbol: string | null;
      source: string | null;
      payload: string | null;
      display_query: string;
      telegram_chat_id: string;
    }[];
    if (rows.length === 0) return;
    const markStmt = db.prepare(
      "UPDATE alerts SET delivered_telegram = 1 WHERE id = ?"
    );
    const unlinkStmt = db.prepare(
      "UPDATE watched_queries SET telegram_chat_id = NULL WHERE id = ?"
    );
    const site = siteUrl();
    for (const row of rows) {
      let payload: unknown;
      if (row.payload != null) {
        try {
          payload = JSON.parse(row.payload);
        } catch {
          /* malformed payload — format without it */
        }
      }
      const input: AlertMessageInput = {
        displayQuery: row.display_query,
        name: row.name,
        symbol: row.symbol,
        source: row.source,
        mint: row.mint,
        payload,
      };
      const text =
        row.kind === "flip"
          ? formatFlipAlertMessage(input, site)
          : formatCloneAlertMessage(input, site);
      try {
        await tgCall("sendMessage", {
          chat_id: row.telegram_chat_id,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        markStmt.run(row.id);
      } catch (err) {
        const fe = err instanceof FetchError ? err : null;
        const status = fe?.kind === "http" ? fe.status : undefined;
        if (status === 429) {
          // Bot-wide rate limit — stop the batch, retry next tick.
          return;
        }
        if (status === 403) {
          // Bot blocked / chat gone: unlink so this watch stops queueing.
          try {
            unlinkStmt.run(row.watch_id);
            markStmt.run(row.id);
          } catch {
            /* best-effort */
          }
          continue;
        }
        if (status !== undefined && status >= 400 && status < 500) {
          // Permanent rejection (bad chat id, bad markup, …) — drop it.
          try {
            markStmt.run(row.id);
          } catch {
            /* best-effort */
          }
          continue;
        }
        // Timeout/network/5xx: leave undelivered for the next tick.
      }
    }
  } catch {
    /* telegram is best-effort — never kills a tick */
  }
}
