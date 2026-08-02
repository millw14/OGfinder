import crypto from "crypto";
import { getDb, getPollState, setPollState } from "./url-index";
import { fetchWithTimeout, FetchError } from "./fetch";
import { scanMint, type MintScanOutcome, type MintScanPayload } from "./scan";
import { encodeSharePayload, formatShareDate, type SharePayload } from "./share";
import { timeAgo, formatAgeGap } from "./format";
import { isLikelyMintAddress } from "./solana";

/**
 * Telegram bot, fully env-gated: without TELEGRAM_BOT_TOKEN every export
 * early-returns (null / no-op) and the app behaves exactly as before.
 * Raw Bot API calls (getMe/getUpdates/sendMessage) — no SDK.
 *
 * Two delivery paths:
 * - Updates (DM commands, group membership, CA verdict replies) arrive via a
 *   DEDICATED getUpdates long-poll loop (ensureTelegramLoopStarted), NOT the
 *   30s poller tick — replies must feel instant.
 * - Watch alerts still go out from the poller tick (sendPendingTelegramAlerts).
 *
 * Linking stays deep-link based: /start w_<id>_<secret> proves watch
 * ownership (the watch secret is the only credential), so no accounts here
 * either. Every handler swallows its own failures — a poison update must
 * never wedge the loop, and alert delivery must never kill a tick.
 */

const TG_API = "https://api.telegram.org";
const TG_TIMEOUT = 10_000;
/** Max updates consumed per getUpdates call. */
const UPDATES_PER_POLL = 50;
/** Max alert sendMessage calls per tick. */
const SENDS_PER_TICK = 20;
/** Throttle failed getMe retries — telegramLinkUrl runs on request paths. */
const GETME_RETRY_MS = 60_000;
/** Long-poll: server-side wait (s) — Telegram holds the request this long. */
const LONG_POLL_WAIT_S = 25;
/** Long-poll: client-side abort (ms) — must exceed the server-side wait. */
const LONG_POLL_ABORT_MS = 35_000;
/** Backoff after a failed poll (network error, 409 conflict, abort). */
const LOOP_ERROR_SLEEP_MS = 5_000;
/** Max CA candidates answered per message. */
const MAX_MINTS_PER_MESSAGE = 2;
/** Same mint in the same chat inside this window → silently skip. */
const VERDICT_COOLDOWN_MS = 10 * 60_000;
/** Cooldown map entry bound (in-memory). */
const VERDICT_COOLDOWN_MAX = 4_096;
/** Global cap on bot-triggered scans in flight, across all chats. */
const MAX_CONCURRENT_BOT_SCANS = 3;

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

interface TelegramChat {
  id?: number | string;
  type?: string;
  title?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    from?: { is_bot?: boolean };
    chat?: TelegramChat;
    text?: string;
    caption?: string;
  };
  my_chat_member?: {
    chat?: TelegramChat;
    new_chat_member?: { status?: string };
  };
}

// ————————————————————— CA extraction + verdict replies —————————————————————

/**
 * Base58 runs of 32-44 chars with non-alphanumeric boundaries on both sides.
 * URL support comes free: dexscreener/birdeye/pump.fun/solscan links delimit
 * the mint with "/" or "?", both boundary characters.
 */
const MINT_CANDIDATE_RE =
  /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g;

/** Regex-scan bound for pathological message sizes. */
const MAX_SCAN_TEXT = 4_096;

/** Unique likely-mint candidates from message text/caption, capped. Pure. */
export function extractMintCandidates(
  text: string,
  cap = MAX_MINTS_PER_MESSAGE
): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, MAX_SCAN_TEXT).matchAll(MINT_CANDIDATE_RE)) {
    const candidate = m[0];
    if (!isLikelyMintAddress(candidate)) continue;
    if (out.includes(candidate)) continue;
    out.push(candidate);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Bounded per-chat/per-mint cooldown map. check() returns true when the pair
 * was answered inside the TTL; otherwise it records `now` and returns false.
 * Exported for tests.
 */
export class VerdictCooldown {
  private m = new Map<string, number>();
  constructor(
    private ttlMs: number,
    private maxEntries: number
  ) {}

  get size(): number {
    return this.m.size;
  }

  check(chatId: string, mint: string, now = Date.now()): boolean {
    const key = `${chatId}:${mint}`;
    const last = this.m.get(key);
    if (last !== undefined && now - last < this.ttlMs) return true;
    if (this.m.size >= this.maxEntries) {
      for (const [k, t] of this.m) {
        if (now - t >= this.ttlMs) this.m.delete(k);
      }
      // Still full (all fresh): evict oldest-inserted to stay bounded.
      while (this.m.size >= this.maxEntries) {
        const oldest = this.m.keys().next().value;
        if (oldest === undefined) break;
        this.m.delete(oldest);
      }
    }
    this.m.delete(key); // refresh insertion order for the eviction sweep
    this.m.set(key, now);
    return false;
  }
}

function fmtPrice(v: number): string {
  if (v >= 1) {
    return `$${v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  // Sub-$1: keep 3 significant digits without exponent notation.
  const decimals = Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(v))));
  return `$${v.toFixed(decimals)}`;
}

function fmtCompactUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

/** Share URL whose /api/og card Telegram unfurls — built like ScanHero's shareVerdict. */
export function verdictShareUrl(
  mint: string,
  payload: MintScanPayload,
  site: string
): string {
  const scanned = payload.results.find((t) => t.mint === mint);
  const share: SharePayload = {
    n: scanned?.displayName ?? payload.scanName ?? "Unknown token",
    s: scanned?.displaySymbol ?? payload.scanSymbol ?? "",
    d: scanned?.createdAt ?? null,
    r: scanned?.rank ?? null,
    t: payload.results.length,
    o: scanned?.rank === 1,
    m: mint,
  };
  return `${site}/?q=${encodeURIComponent(mint)}&v=${encodeSharePayload(share)}`;
}

/**
 * Compact HTML verdict message for a completed scan. Pure — exported for
 * tests. Verdict derivation mirrors the route's scanResponseBody: the scanned
 * token's rank decides OG-ness (rank 1 = OG); results[0] is the OG.
 */
export function formatMintVerdict(
  mint: string,
  payload: MintScanPayload,
  site: string
): string {
  const scanned = payload.results.find((t) => t.mint === mint);
  const name = escapeHtml(
    scanned?.displayName ?? payload.scanName ?? "Unknown token"
  );
  const symbol = scanned?.displaySymbol ?? payload.scanSymbol ?? null;
  const sym = symbol ? ` ($${escapeHtml(symbol)})` : "";
  if (!scanned) {
    return `🔍 Resolved <b>${name}</b>${sym} but couldn't rank it against lookalikes — try a name search on OGfinder.`;
  }
  const total = payload.results.length;
  const og = payload.results[0];
  const isOG = scanned.rank === 1;

  const lines: string[] = [];
  lines.push(
    isOG
      ? `👑 <b>THIS IS THE OG</b> — ${name}${sym}`
      : `🚫 <b>NOT THE OG</b> — ${name}${sym} is #${scanned.rank} of ${total} by age`
  );

  const minted = formatShareDate(scanned.createdAt) ?? "unknown date";
  const ago = timeAgo(scanned.createdAt);
  lines.push(`minted ${minted}${ago ? ` (${ago})` : ""}`);
  if (!isOG && og && og.mint !== mint) {
    const ogDate = formatShareDate(og.createdAt) ?? "unknown date";
    const gapMs =
      scanned.createdAtMs != null && og.createdAtMs != null
        ? scanned.createdAtMs - og.createdAtMs
        : null;
    const gap = gapMs != null && gapMs > 0 ? ` (${formatAgeGap(gapMs)} older)` : "";
    lines.push(
      `OG: <b>${escapeHtml(og.displayName)}</b> minted ${ogDate}${gap} — <code>${escapeHtml(og.mint)}</code>`
    );
  }

  const risk: string[] = [];
  if (scanned.mintAuthorityActive === false) risk.push("🔒 renounced");
  if (scanned.mintAuthorityActive === true) risk.push("⚠️ mint auth active");
  if (scanned.freezeAuthorityActive === true) risk.push("⚠️ freeze auth");
  if (scanned.metadataMutable === true) risk.push("✏️ mutable metadata");
  if (scanned.topHolderPct != null) {
    risk.push(`👥 top10 hold ${Math.round(scanned.topHolderPct)}%`);
  }
  if (scanned.homoglyphSuspect) risk.push("🎭 lookalike characters");
  if (risk.length > 0) lines.push(risk.join(" · "));

  const market: string[] = [];
  if (scanned.priceUsd != null && scanned.priceUsd > 0) {
    market.push(fmtPrice(scanned.priceUsd));
  }
  if (scanned.liquidityUsd != null && scanned.liquidityUsd > 0) {
    market.push(`liq ${fmtCompactUsd(scanned.liquidityUsd)}`);
  }
  if (scanned.priceChange24h != null) {
    const pc = scanned.priceChange24h;
    market.push(`${pc >= 0 ? "+" : ""}${pc.toFixed(1)}% 24h`);
  }
  if (market.length > 0) lines.push(`💰 ${market.join(" · ")}`);

  lines.push(
    [
      `<a href="${verdictShareUrl(mint, payload, site)}">OGfinder verdict</a>`,
      `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
      `<a href="https://trade.padre.gg/trade/solana/${mint}">Padre</a>`,
    ].join(" · ")
  );
  return lines.join("\n");
}

/** sendMessage returning the new message_id (null on any failure). */
async function sendChatMessage(
  chatId: string,
  text: string,
  opts?: { replyToMessageId?: number }
): Promise<number | null> {
  try {
    const res = (await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(opts?.replyToMessageId != null
        ? {
            reply_parameters: {
              message_id: opts.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    })) as { ok?: boolean; result?: { message_id?: number } } | null;
    const id = res?.result?.message_id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

const verdictCooldown = new VerdictCooldown(
  VERDICT_COOLDOWN_MS,
  VERDICT_COOLDOWN_MAX
);
let botScansInFlight = 0;

/** Edit the placeholder into the final verdict (or a short error). Never throws. */
async function finishVerdict(
  chatId: string,
  messageId: number,
  mint: string,
  outcome: MintScanOutcome | null
): Promise<void> {
  try {
    if (outcome?.ok) {
      const site = siteUrl();
      await tgCall("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: formatMintVerdict(mint, outcome.payload, site),
        parse_mode: "HTML",
        // Unfurl the OGfinder share link into its og:image verdict card.
        link_preview_options: {
          is_disabled: false,
          url: verdictShareUrl(mint, outcome.payload, site),
        },
      });
    } else {
      await tgCall("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: "Couldn't verify this mint — not found on-chain or upstream APIs down",
      });
    }
  } catch {
    /* verdict edit is best-effort */
  }
}

async function handleCandidateMints(
  chatId: string,
  replyToMessageId: number | undefined,
  text: string
): Promise<void> {
  for (const mint of extractMintCandidates(text)) {
    if (verdictCooldown.check(chatId, mint)) continue;
    if (botScansInFlight >= MAX_CONCURRENT_BOT_SCANS) {
      await sendChatMessage(chatId, "⏳ busy, try again in a moment", {
        replyToMessageId,
      });
      continue;
    }
    const placeholderId = await sendChatMessage(
      chatId,
      "🔍 Checking if this is the OG…",
      { replyToMessageId }
    );
    if (placeholderId == null) continue;
    // Detached on purpose: the long-poll loop stays responsive while the scan
    // runs; botScansInFlight bounds total concurrent pipeline work. scanMint
    // shares caches + in-flight coalescing with web scans, so warm mints are
    // near-instant.
    botScansInFlight++;
    void scanMint(mint)
      .then(
        (outcome) => finishVerdict(chatId, placeholderId, mint, outcome),
        () => finishVerdict(chatId, placeholderId, mint, null)
      )
      .finally(() => {
        botScansInFlight--;
      });
  }
}

// ————————————————————————— Group registry —————————————————————————

const WELCOME_HTML =
  "👑 OGfinder is live in this chat. Paste any Solana CA and I'll instantly " +
  "verify if it's the original token — age rank, risk flags, and market data. " +
  "Commands: /og &lt;mint or name&gt;, /watch &lt;name&gt; for new-clone alerts here, /help.";

function isActiveTelegramGroup(chatId: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT active FROM telegram_groups WHERE chat_id = ?")
      .get(chatId) as { active: number } | undefined;
    return row?.active === 1;
  } catch {
    return false;
  }
}

async function handleMyChatMember(
  m: NonNullable<TelegramUpdate["my_chat_member"]>
): Promise<void> {
  const chat = m.chat;
  const status = m.new_chat_member?.status;
  if (!chat || chat.id == null || !status) return;
  const type = chat.type ?? "";
  if (type !== "group" && type !== "supergroup") return;
  const chatId = String(chat.id);

  if (status === "member" || status === "administrator") {
    let welcomeSent = 1; // fail-safe: DB broken → don't risk repeated welcomes
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO telegram_groups (chat_id, title, added_at, welcome_sent, active)
         VALUES (?, ?, ?, 0, 1)
         ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1`
      ).run(chatId, chat.title ?? null, Date.now());
      const row = db
        .prepare("SELECT welcome_sent FROM telegram_groups WHERE chat_id = ?")
        .get(chatId) as { welcome_sent: number } | undefined;
      welcomeSent = row?.welcome_sent ?? 1;
    } catch {
      return;
    }
    if (welcomeSent === 0) {
      await reply(chatId, WELCOME_HTML);
      try {
        getDb()
          .prepare("UPDATE telegram_groups SET welcome_sent = 1 WHERE chat_id = ?")
          .run(chatId);
      } catch {
        /* best-effort */
      }
    }
    return;
  }
  if (status === "left" || status === "kicked") {
    try {
      getDb()
        .prepare("UPDATE telegram_groups SET active = 0 WHERE chat_id = ?")
        .run(chatId);
    } catch {
      /* best-effort */
    }
  }
}

// ————————————————————————— Update router —————————————————————————

/**
 * Route one Telegram update. Exported so tests can drive it with fixture
 * Update objects. Never throws — a poison update must not wedge the loop.
 * Note: the loop subscribes only ["message","my_chat_member"], so edited
 * messages (edited_message updates) never arrive here.
 */
export async function handleTelegramUpdate(u: TelegramUpdate): Promise<void> {
  try {
    if (u.my_chat_member) {
      await handleMyChatMember(u.my_chat_member);
      return;
    }
    const msg = u.message;
    if (!msg || msg.from?.is_bot) return;
    const chatIdRaw = msg.chat?.id;
    if (chatIdRaw == null) return;
    const chatId = String(chatIdRaw);
    const text =
      typeof msg.text === "string"
        ? msg.text
        : typeof msg.caption === "string"
          ? msg.caption
          : null;
    if (text == null) return;
    const chatType = msg.chat?.type ?? "";

    if (chatType === "private") {
      const cmd = parseTelegramCommand(text);
      if (cmd) {
        if (cmd.command === "start") await handleStart(chatId, cmd.arg);
        else if (cmd.command === "stop") await handleStop(chatId);
        else await handleList(chatId);
        return;
      }
      await handleCandidateMints(chatId, msg.message_id, text);
      return;
    }
    if (chatType === "group" || chatType === "supergroup") {
      if (!isActiveTelegramGroup(chatId)) return;
      await handleCandidateMints(chatId, msg.message_id, text);
    }
  } catch {
    /* one bad update must not stall the rest */
  }
}

// ————————————————————————— Long-poll loop —————————————————————————
//
// ⚠️ ONE BOT, ONE CONSUMER: dev and prod share the same TELEGRAM_BOT_TOKEN,
// and Telegram delivers each update to exactly ONE getUpdates consumer. A dev
// server polling by default would STEAL updates from the production loop, so
// the loop only starts when NODE_ENV === "production", or when the explicit
// escape hatch TELEGRAM_FORCE_POLL=1 is set for one-shot local verification
// (expect 409 conflicts while prod's poll holds the connection).

interface TelegramLoopState {
  started: boolean;
  polling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

// globalThis-guarded like the poller: dev HMR module reloads must not spawn a
// second loop (two consumers on one token drop updates on the floor).
const G_TG = globalThis as typeof globalThis & {
  __ogfinderTgLoop?: TelegramLoopState;
};

function getLoopState(): TelegramLoopState {
  if (!G_TG.__ogfinderTgLoop) {
    G_TG.__ogfinderTgLoop = { started: false, polling: false, timer: null };
  }
  return G_TG.__ogfinderTgLoop;
}

/**
 * Raw long-poll fetch. Deliberately NOT fetchWithTimeout: no retry loop, no
 * per-host semaphore, and api.telegram.org stays out of the provider-health
 * counters (a 25s hold per call would read as permanent slowness).
 */
async function tgLongPollFetch(
  offset: number
): Promise<{ ok?: boolean; result?: TelegramUpdate[] } | null> {
  const token = botToken();
  if (!token) return null;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), LONG_POLL_ABORT_MS);
  abortTimer.unref?.();
  try {
    const res = await fetch(`${TG_API}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        limit: UPDATES_PER_POLL,
        timeout: LONG_POLL_WAIT_S,
        allowed_updates: ["message", "my_chat_member"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Message never includes the URL (it carries the bot token).
      throw new FetchError("http", `HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
  } finally {
    clearTimeout(abortTimer);
  }
}

/**
 * One getUpdates long-poll + dispatch. The offset lives in poll_state
 * 'tg:update_offset' and advances past every fetched update — even ones whose
 * handling failed — so a poison message can't wedge the queue.
 */
async function pollTelegramOnce(): Promise<void> {
  let offset = 0;
  try {
    const stored = Number(getPollState("tg:update_offset"));
    if (Number.isFinite(stored) && stored > 0) offset = stored;
  } catch {
    /* poll_state unavailable — offset 0 */
  }
  const res = await tgLongPollFetch(offset);
  // null (token vanished) or ok:false both back off instead of hot-looping.
  if (!res?.ok) throw new Error("getUpdates not ok");
  if (!Array.isArray(res.result) || res.result.length === 0) return;
  let maxUpdateId = offset - 1;
  for (const u of res.result) {
    if (typeof u.update_id === "number" && u.update_id > maxUpdateId) {
      maxUpdateId = u.update_id;
    }
    await handleTelegramUpdate(u);
  }
  try {
    setPollState("tg:update_offset", String(maxUpdateId + 1));
  } catch {
    /* poll_state is best-effort */
  }
}

let devGateLogged = false;

/**
 * Start the dedicated getUpdates long-poll loop (idempotent). Called from
 * instrumentation register + the search route fallback, same as
 * ensurePollerStarted. Gated OFF outside production unless
 * TELEGRAM_FORCE_POLL=1 — see the ONE BOT, ONE CONSUMER note above.
 */
export function ensureTelegramLoopStarted(): void {
  if (!isTelegramEnabled()) return;
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.TELEGRAM_FORCE_POLL !== "1"
  ) {
    if (process.env.NODE_ENV === "development" && !devGateLogged) {
      devGateLogged = true;
      console.log(
        "[telegram] long-poll loop disabled outside production — set TELEGRAM_FORCE_POLL=1 to override (WARNING: steals updates from the prod bot)"
      );
    }
    return;
  }
  const state = getLoopState();
  if (state.started) return;
  // Same DB probe as ensurePollerStarted: refuse to claim the globalThis
  // started flag from a module graph whose better-sqlite3 binding is broken —
  // the context that can actually reach the DB wins.
  try {
    getDb().prepare("SELECT 1").get();
  } catch {
    if (process.env.NODE_ENV === "development") {
      console.log("[telegram] DB unavailable in this context — deferring loop start");
    }
    return;
  }
  state.started = true;
  console.log("[telegram] starting getUpdates long-poll loop");
  // Self-scheduling: the next poll is only armed after the current one fully
  // settles (loop immediately on success, back off LOOP_ERROR_SLEEP_MS on error).
  const run = async (): Promise<void> => {
    if (state.polling) return;
    state.polling = true;
    let delayMs = 0;
    try {
      await pollTelegramOnce();
    } catch {
      delayMs = LOOP_ERROR_SLEEP_MS;
    } finally {
      state.polling = false;
    }
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    state.timer = timer;
  };
  void run();
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
