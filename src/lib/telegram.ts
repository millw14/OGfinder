import crypto from "crypto";
import { getDb, getPollState, setPollState } from "./url-index";
import { fetchWithTimeout, FetchError } from "./fetch";
import {
  scanMint,
  coalesce,
  FAST_TTL,
  type MintScanOutcome,
  type MintScanPayload,
} from "./scan";
import {
  encodeSafetyMarker,
  encodeSharePayload,
  formatShareDate,
  UNPROVEN_MARKER,
  type SharePayload,
} from "./share";
import {
  blockingFlags,
  headlineBlockingFlag,
  orderSafetyFlags,
} from "./safety-view";
import { timeAgo, formatAgeGap } from "./format";
import { isLikelyMintAddress } from "./solana";
import {
  MIN_QUERY,
  MAX_QUERY,
  SERIAL_DEPLOYER_MIN,
  FRESH_WALLET_MS,
  TOKENS_CREATED_CAP,
  type TokenResult,
} from "./types";
import { normalize, skeleton } from "./normalize";
import { getAssetBatch } from "./helius";
import {
  getRegisteredOg,
  isRegistryFresh,
  type OgRegistryEntry,
} from "./og-registry";
import { ageOrderConfidence } from "./sort";
import { getSearchCache, setSearchCache } from "./cache";
import { searchTokens } from "./search";
import { buildTokenResults } from "./enrich-results";
import {
  createWatch,
  telegramWatchIpKey,
  listWatchesForTelegramChat,
  unwatchForTelegramChat,
  type CreateWatchResult,
} from "./watches";

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
  // Env wins even without a token — lets tests exercise @mention gating and
  // never changes prod behavior (prod always has both or neither).
  const fromEnv = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (fromEnv) return fromEnv;
  if (!isTelegramEnabled()) return null;
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

export interface BotCommand {
  command: "og" | "watch" | "watches" | "unwatch" | "help";
  /** @BotName suffix without the '@', as typed (null when absent). */
  mention: string | null;
  /** Everything after the command, trimmed; null when empty. */
  arg: string | null;
}

// "watches" before "watch" so the longer command wins without backtracking.
// Unlike the legacy single-token parser, the arg spans the rest of the
// message — watch names and token names can contain spaces.
const BOT_COMMAND_RE =
  /^\/(og|watches|watch|unwatch|help)(?:@(\S+))?(?:\s+([\s\S]+?))?\s*$/i;

/**
 * Parse the group/DM command set (/og /watch /watches /unwatch /help).
 * Case-insensitive; captures an @BotName mention for the router to gate on
 * (with group privacy ON, Telegram delivers every /command to every bot).
 */
export function parseBotCommand(text: string): BotCommand | null {
  const m = BOT_COMMAND_RE.exec(text.trim());
  if (!m) return null;
  return {
    command: m[1].toLowerCase() as BotCommand["command"],
    mention: m[2] ?? null,
    arg: m[3] ?? null,
  };
}

/**
 * Commands addressed to another bot (/og@OtherBot) are not for us. When our
 * own username is unknown (no env, getMe unreachable) stay permissive so
 * commands never dead-end — matches the legacy parser's accept-any-@ behavior.
 */
async function commandIsForThisBot(mention: string | null): Promise<boolean> {
  if (!mention) return true;
  const username = await getBotUsername();
  if (!username) return true;
  return mention.toLowerCase() === username.toLowerCase();
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

/**
 * Clone alert body (Telegram HTML parse mode), on the same block layout as the
 * verdicts: headline · subject · actions, separated by a blank line. Pure.
 */
export function formatCloneAlertMessage(
  a: AlertMessageInput,
  site: string
): string {
  const name = escapeHtml(a.name ?? "Unnamed token");
  const sym = a.symbol ? ` ($${escapeHtml(a.symbol)})` : "";
  const blocks: string[] = [
    `🚨 <b>NEW CLONE</b> · “${escapeHtml(a.displayQuery)}”`,
  ];
  // Subject: identity, then one glyph-led fact row each. Nothing was pasted
  // here, so unlike a verdict the mint IS new information — it earns a <code>
  // block the reader can tap to copy.
  const subject: string[] = [`<b>${name}</b>${sym}`];
  if (a.source) subject.push(`🔎 spotted via ${escapeHtml(a.source)}`);
  if (a.mint) subject.push(`<code>${escapeHtml(a.mint)}</code>`);
  blocks.push(subject.join("\n"));
  if (a.mint) {
    blocks.push(
      [
        `<a href="${site}/?q=${encodeURIComponent(a.mint)}">Verdict card</a>`,
        `<a href="https://dexscreener.com/solana/${encodeURIComponent(
          a.mint
        )}">Chart</a>`,
      ].join(" · ")
    );
  }
  return blocks.join("\n\n");
}

/**
 * Flip alert body, same block layout. Flip rows (NULL mint allowed) carry
 * their context in the payload JSON — render a payload `message` string when
 * present. Every block below the headline is optional, so a bare flip row
 * degrades to the headline alone rather than to empty blocks. Pure.
 */
export function formatFlipAlertMessage(
  a: AlertMessageInput,
  site: string
): string {
  const p =
    typeof a.payload === "object" && a.payload !== null
      ? (a.payload as Record<string, unknown>)
      : {};
  const blocks: string[] = [
    `🔁 <b>WATCH UPDATE</b> · “${escapeHtml(a.displayQuery)}”`,
  ];
  const subject: string[] = [];
  if (a.name || a.symbol) {
    const nm = escapeHtml(a.name ?? "Unnamed token");
    const sym = a.symbol ? ` ($${escapeHtml(a.symbol)})` : "";
    subject.push(`<b>${nm}</b>${sym}`);
  }
  if (typeof p.message === "string" && p.message) {
    subject.push(`ℹ️ ${escapeHtml(p.message)}`);
  }
  if (a.mint) subject.push(`<code>${escapeHtml(a.mint)}</code>`);
  if (subject.length > 0) blocks.push(subject.join("\n"));
  if (a.mint) {
    blocks.push(
      `<a href="${site}/?q=${encodeURIComponent(a.mint)}">Verdict card</a>`
    );
  }
  return blocks.join("\n\n");
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
      '👑 <b>OGfinder</b>\n\nLink a watch from the OGfinder site · the "Get Telegram alerts" button opens this chat with the right code.'
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
      "❌ That link doesn't match an active watch · it may have been deleted. Re-create the watch on the site and try again."
    );
    return;
  }
  db.prepare(
    "UPDATE watched_queries SET telegram_chat_id = ? WHERE id = ?"
  ).run(chatId, parsed.watchId);
  await reply(
    chatId,
    `✅ <b>Linked</b> · new-clone alerts for “${escapeHtml(row.display_query)}” land here.\n\nSend /stop to unlink.`
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
      ? `✅ Unlinked ${info.changes} watch${info.changes === 1 ? "" : "es"} · no more alerts in this chat.`
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
      `• <b>${escapeHtml(r.display_query)}</b> · ${
        r.kind === "mint-cluster" ? "clone-cluster" : "name"
      } watch`
  );
  await reply(
    chatId,
    [
      "👀 <b>Watches linked to this chat</b>",
      lines.join("\n"),
      "Send /stop to unlink all.",
    ].join("\n\n")
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

/** "2.3" not "2.30", and "412" not "412.0" — a trailing .0 just adds noise. */
function trimTenth(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

function fmtCompactUsd(v: number): string {
  if (v >= 1e9) return `$${trimTenth(v / 1e9)}B`;
  if (v >= 1e6) return `$${trimTenth(v / 1e6)}M`;
  if (v >= 1e3) return `$${trimTenth(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/**
 * Deployer intelligence line for a scanned token:
 * "👤 dev: <short> · N tokens created · wallet since <year>". Serial deployers
 * (≥ SERIAL_DEPLOYER_MIN launches) and fresh wallets (< 7 days) get ⚠️
 * prefixes; unknown fields are omitted; no deployer → null (no line at all).
 * Pure; exported for tests.
 */
export function formatDeployerLine(
  t: TokenResult,
  now = Date.now()
): string | null {
  const addr = t.deployerAddress;
  if (!addr) return null;
  const short =
    addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
  const parts: string[] = [`👤 dev: <code>${escapeHtml(short)}</code>`];
  const n = t.deployerTokensCreated;
  if (n != null) {
    const shown = `${n}${n >= TOKENS_CREATED_CAP ? "+" : ""}`;
    parts.push(
      n >= SERIAL_DEPLOYER_MIN
        ? `⚠️ serial deployer: ${shown} tokens created`
        : `${shown} token${n === 1 ? "" : "s"} created`
    );
  }
  if (t.deployerWalletFirstSeenMs != null) {
    parts.push(
      now - t.deployerWalletFirstSeenMs < FRESH_WALLET_MS
        ? "⚠️ fresh wallet"
        : `wallet since ${new Date(t.deployerWalletFirstSeenMs).getUTCFullYear()}`
    );
  } else if (t.deployerIsOldWallet) {
    parts.push("established wallet");
  }
  return parts.join(" · ");
}

// ————————————————————————— safety lines —————————————————————————
//
// THE BOT IS WHERE A VERDICT IS ACTED ON. A crown here is read as an
// endorsement, so it is gated on the same safetyLevel the web UI uses:
//  - "danger" → the warning leads, the crown never appears, and each blocking
//    finding is named by its mechanism (never a generic "SCAM").
//  - "caution" → the normal verdict plus a warning line.
//  - "clear" → "no blocking flags found" (an absence of findings, never "safe").
//  - "unknown" → "safety checks unavailable" (an unrun check is not a pass).
//  - ABSENT → the token was never assessed; the legacy DAS chips render exactly
//    as they did before, and nothing claims a safety result either way.

/** Headline shown instead of the crown/rank line for a blocking verdict. */
export const UNSAFE_HEADLINE = "🛑 <b>UNSAFE — DO NOT BUY</b>";
/** Rank-1 age statement for a blocking verdict: fact kept, endorsement withheld. */
export const UNSAFE_RANK1_LINE =
  "oldest by age, but OGfinder will not call it the OG";
/** Headline for a rank 1 whose ORDER is unproven — never the crown. */
export const UNPROVEN_HEADLINE = "🕰 <b>OLDEST KNOWN SO FAR</b>";

/**
 * "oldest known so far — 3 tokens still unresolved". The count is the server's
 * (it saw the cohort before the MAX_RESULTS slice); without it we still say
 * the order is unproven rather than implying it is settled. Pure.
 */
export function formatUnprovenSuffix(count?: number | null): string {
  if (count == null || count <= 0) return "order not proven";
  return `${count} token${count === 1 ? "" : "s"} still unresolved`;
}

/**
 * A date we only hold an upper limit for is never printed bare: a truncated
 * signature walk proves "existed by this date", not "created on it". Pure.
 */
function mintedDate(t: TokenResult | undefined): string {
  const date = formatShareDate(t?.createdAt ?? null) ?? "unknown date";
  if (!t?.createdAtIsLowerBound || date === "unknown date") return date;
  return `on or before ${date}`;
}

/**
 * "⛔ freeze authority active · permanent delegate set" — the blocking findings
 * named one by one. Null when nothing blocks (or no codes survived decoding).
 * Pure; exported for tests.
 */
export function formatBlockingFlagLine(t: TokenResult): string | null {
  const flags = blockingFlags(t.safetyFlags);
  if (flags.length === 0) return null;
  return `⛔ ${flags.map((f) => escapeHtml(f.label)).join(" · ")}`;
}

/**
 * Risk-slot content for an ASSESSED token: caution findings (blocking ones
 * already lead the message), or the level's own statement when there are none.
 * Pure; exported for tests.
 */
export function formatSafetyRiskChip(t: TokenResult): string | null {
  switch (t.safetyLevel) {
    case "danger":
    case "caution": {
      const cautions = orderSafetyFlags(t.safetyFlags).filter(
        (f) => f.tier === "caution"
      );
      if (cautions.length === 0) return null;
      return `⚠️ ${cautions.map((f) => escapeHtml(f.label)).join(" · ")}`;
    }
    case "clear":
      // Deliberately not "safe": we only ever report what we did not find.
      return "🔎 no blocking flags found";
    case "unknown":
      return "❔ safety checks unavailable";
    default:
      return null;
  }
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
  // ?sf= rides BESIDE ?v= exactly as ScanHero builds it, so the card Telegram
  // unfurls for a blocking verdict is the red mechanism card, not a gold "OG"
  // one. The ?v= payload itself is untouched (its contract is frozen).
  const marker =
    scanned?.safetyLevel === "danger"
      ? headlineBlockingFlag(scanned.safetyFlags)
      : null;
  const sf = marker
    ? `&sf=${encodeURIComponent(encodeSafetyMarker(marker.code))}`
    : "";
  // ?u=1, same sibling treatment: a rank-1 whose ordering is unproven must not
  // unfurl as a gold "OG" card in the chat.
  const u =
    share.o && ageOrderUnprovenFor(payload) ? `&u=${UNPROVEN_MARKER}` : "";
  return `${site}/?q=${encodeURIComponent(mint)}&v=${encodeSharePayload(
    share
  )}${sf}${u}`;
}

/**
 * Does this payload's #1 answer rest on an unproven ordering? Server-computed
 * (scan.ts) with the rank-1 stamp as the fallback, so a payload built before
 * the response-level field existed still reads correctly. Pure.
 */
function ageOrderUnprovenFor(payload: MintScanPayload): boolean {
  return (
    payload.ageOrderUnproven === true ||
    payload.results[0]?.ageOrderUnproven === true
  );
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
  const danger = scanned.safetyLevel === "danger";
  // The oldest token we could date is not necessarily the oldest token: a
  // lookalike whose history was too deep to walk to the end could predate it.
  const orderUnproven = ageOrderUnprovenFor(payload);

  // ── BLOCK 1 · VERDICT ────────────────────────────────────────────────
  // One bold headline, nothing else competing with it. THREE MUTUALLY
  // EXCLUSIVE BRANCHES: the crown lives in the last one and nowhere else, so
  // neither a blocking flag nor an unprovable ordering can reach it.
  const verdict: string[] = [];
  if (danger) {
    // The warning leads. A blocking flag costs the endorsement, never the
    // rank, so the age fact is still stated below (just not as advice).
    verdict.push(UNSAFE_HEADLINE);
    const blocking = formatBlockingFlagLine(scanned);
    if (blocking) verdict.push(blocking);
    verdict.push(
      isOG
        ? `🕰 ${UNSAFE_RANK1_LINE}`
        : `🚫 not the OG · #${scanned.rank} of ${total} by age`
    );
  } else if (isOG && orderUnproven) {
    verdict.push(
      `${UNPROVEN_HEADLINE} · ${formatUnprovenSuffix(payload.ageUnresolvedCount)}`
    );
  } else if (isOG) {
    verdict.push("👑 <b>THIS IS THE OG</b>");
  } else {
    verdict.push(
      `🚫 <b>NOT THE OG</b> · #${scanned.rank} of ${total} by age`
    );
  }
  const blocks: string[] = [verdict.join("\n")];

  // ── BLOCK 2 · THE TOKEN ──────────────────────────────────────────────
  // Identity first, then one glyph-led fact row each: age, safety, dev,
  // market. The pasted CA is deliberately NOT echoed — the reader just sent
  // it; the mint that earns space here is the OG's, in block 3.
  const subject: string[] = [`<b>${name}</b>${sym}`];

  // "minted on or before <date>" whenever the walk was truncated — and the age
  // becomes a minimum, since creation at or before T means at least that old.
  const minted = mintedDate(scanned);
  const ago = timeAgo(scanned.createdAt);
  const agoText = ago
    ? scanned.createdAtIsLowerBound
      ? ` · at least ${ago}`
      : ` · ${ago}`
    : "";
  subject.push(`📅 minted ${minted}${agoText}`);

  const risk: string[] = [];
  if (scanned.safetyLevel) {
    // Assessed: the safety engine owns the risk slot, so its findings can't
    // contradict the verdict line above (and can't be double-printed).
    const chip = formatSafetyRiskChip(scanned);
    if (chip) risk.push(chip);
    if (scanned.topHolderPct != null) {
      risk.push(`👥 top 10 hold ${Math.round(scanned.topHolderPct)}%`);
    }
  } else {
    // Never assessed (ranks 2+ of a scan, or a build without the checks): the
    // legacy DAS chips, unchanged — they describe fields, not a verdict.
    if (scanned.mintAuthorityActive === false) risk.push("🔒 renounced");
    if (scanned.mintAuthorityActive === true) risk.push("⚠️ mint auth active");
    if (scanned.freezeAuthorityActive === true) risk.push("⚠️ freeze auth");
    if (scanned.metadataMutable === true) risk.push("✏️ mutable metadata");
    if (scanned.topHolderPct != null) {
      risk.push(`👥 top 10 hold ${Math.round(scanned.topHolderPct)}%`);
    }
    if (scanned.homoglyphSuspect) risk.push("🎭 lookalike characters");
  }
  if (risk.length > 0) subject.push(risk.join(" · "));

  const dev = formatDeployerLine(scanned);
  if (dev) subject.push(dev);

  const market: string[] = [];
  const mc = scanned.marketCapUsd ?? scanned.fdvUsd;
  if (mc != null && mc > 0) {
    market.push(`MC ${fmtCompactUsd(mc)}`);
  } else if (scanned.priceUsd != null && scanned.priceUsd > 0) {
    // No market cap reported — price beats showing nothing.
    market.push(fmtPrice(scanned.priceUsd));
  }
  if (scanned.liquidityUsd != null && scanned.liquidityUsd > 0) {
    market.push(`liq ${fmtCompactUsd(scanned.liquidityUsd)}`);
  }
  if (scanned.priceChange24h != null) {
    const pc = scanned.priceChange24h;
    market.push(`${pc >= 0 ? "+" : ""}${pc.toFixed(1)}% 24h`);
  }
  // The raw counts behind a "buys but no sells" finding — shown ONLY when that
  // is what the safety engine flagged, so the reader can check the claim. On a
  // healthy token they are noise that pushes the row past one line.
  const sellFlagged = (scanned.safetyFlags ?? []).some(
    (f) => f === "no-sells" || f === "few-sells"
  );
  if (sellFlagged && scanned.buys24h != null && scanned.sells24h != null) {
    market.push(`${scanned.buys24h} buys / ${scanned.sells24h} sells 24h`);
  }
  if (market.length > 0) subject.push(`💰 ${market.join(" · ")}`);
  blocks.push(subject.join("\n"));

  // ── BLOCK 3 · THE REAL OG ────────────────────────────────────────────
  // Quoted so it reads as its own card: this is the answer the reader came
  // for, and the only mint worth the space is the one they need to copy.
  if (!isOG && og && og.mint !== mint) {
    const gapMs =
      scanned.createdAtMs != null && og.createdAtMs != null
        ? scanned.createdAtMs - og.createdAtMs
        : null;
    // The difference of two dates is exact only when both dates are. With one
    // side a bound the gap is itself a bound; with both, it is unknown.
    const gapQualifier =
      og.createdAtIsLowerBound && scanned.createdAtIsLowerBound
        ? null
        : og.createdAtIsLowerBound
          ? "at least "
          : scanned.createdAtIsLowerBound
            ? "at most "
            : "";
    const gap =
      gapMs != null && gapMs > 0 && gapQualifier != null
        ? ` · ${gapQualifier}${formatAgeGap(gapMs)} older`
        : "";
    // The crown rides on the claim, not the card: when the ordering is
    // unproven this token is only the oldest we could DATE, and the caveat
    // block below says exactly that — so it gets the clock, not the crown.
    const heading = orderUnproven ? "Oldest known" : "The OG";
    const glyph = orderUnproven ? "🕰" : "👑";
    blocks.push(
      `<blockquote>${glyph} <b>${heading}: ${escapeHtml(og.displayName)}</b>\n` +
        `📅 ${mintedDate(og)}${gap}\n` +
        `<code>${escapeHtml(og.mint)}</code></blockquote>`
    );
  }

  // ── BLOCK 4 · THE CAVEAT ─────────────────────────────────────────────
  if (orderUnproven) {
    const n = payload.ageUnresolvedCount;
    blocks.push(
      `⏳ ${
        n != null && n > 0
          ? `${n} matching token${n === 1 ? "" : "s"} ha${n === 1 ? "s" : "ve"}`
          : "A matching token has"
      } a history too deep to date fully — the oldest above is the oldest we can prove, not a verified OG.`
    );
  }

  // ── BLOCK 5 · ACTIONS ────────────────────────────────────────────────
  blocks.push(
    [
      `<a href="${verdictShareUrl(mint, payload, site)}">Verdict card</a>`,
      `<a href="https://dexscreener.com/solana/${mint}">Chart</a>`,
      `<a href="https://trade.padre.gg/trade/solana/${mint}">Trade</a>`,
    ].join(" · ")
  );
  // Blank line between blocks — the whole point of the layout.
  return blocks.join("\n\n");
}

/**
 * Instant answer from the exact-name OG registry, shown while the definitive
 * full scan runs. The final scan message always lands after this one, so a
 * contradiction is resolved by construction — the full verdict wins.
 *
 * IT NEVER CROWNS. The registry only remembers WHICH MINT IS OLDEST for a name
 * (dangerous tokens are barred from it and evicted on sight — og-registry.ts),
 * but the pasted mint's own safety checks have not run yet at this point, and
 * a token's on-chain powers can change after it was registered. So the age
 * fact is stated and the endorsement is deferred to the full verdict — which
 * matters most in the one case the replacement fails to send and this message
 * is the last word in the chat.
 *
 * Pure; exported for tests.
 */
export function formatRegistryVerdict(
  mint: string,
  entry: OgRegistryEntry
): string {
  const name = escapeHtml(entry.ogName);
  const sym = entry.ogSymbol ? ` ($${escapeHtml(entry.ogSymbol)})` : "";
  // Same block layout as the full verdict, so the message it replaces lands
  // in a shape the reader already recognises.
  if (mint === entry.ogMint) {
    const ago = timeAgo(new Date(entry.verifiedAt).toISOString());
    return [
      "🕰 <b>OLDEST BY AGE</b>",
      `<b>${name}</b>${sym}\n📅 oldest of this name · checked ${ago || "recently"}`,
      "<i>From the OGfinder registry — safety checks still running, full verdict next.</i>",
    ].join("\n\n");
  }
  const minted =
    entry.ogCreatedAtMs != null
      ? formatShareDate(new Date(entry.ogCreatedAtMs).toISOString())
      : null;
  return [
    "🚫 <b>NOT THE OG</b>",
    `<blockquote>👑 <b>The OG: ${name}</b>${sym}\n` +
      (minted ? `📅 minted ${minted}\n` : "") +
      `<code>${escapeHtml(entry.ogMint)}</code></blockquote>`,
    "<i>From the OGfinder registry — full re-check running.</i>",
  ].join("\n\n");
}

/** sendMessage returning the new message_id (null on any failure). */
async function sendChatMessage(
  chatId: string,
  text: string,
  opts?: { replyToMessageId?: number; linkPreviewUrl?: string }
): Promise<number | null> {
  try {
    const res = (await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: opts?.linkPreviewUrl
        ? { is_disabled: false, url: opts.linkPreviewUrl }
        : { is_disabled: true },
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

/** Best-effort delete of one of the bot's own messages (own messages are always deletable within 48h). */
async function deleteChatMessage(
  chatId: string,
  messageId: number
): Promise<void> {
  try {
    await tgCall("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {
    /* deletion is best-effort — worst case the old message lingers */
  }
}

/**
 * Replace an interim bot message with a fresh one at the BOTTOM of the chat:
 * send the new message first (so a send failure never orphans the reply),
 * then delete the old one. Active groups bury in-place edits up-scroll —
 * the verdict must arrive as a new message.
 */
async function replaceChatMessage(
  chatId: string,
  oldMessageId: number,
  text: string,
  opts?: { replyToMessageId?: number; linkPreviewUrl?: string }
): Promise<number | null> {
  const newId = await sendChatMessage(chatId, text, opts);
  if (newId != null) await deleteChatMessage(chatId, oldMessageId);
  return newId;
}

const verdictCooldown = new VerdictCooldown(
  VERDICT_COOLDOWN_MS,
  VERDICT_COOLDOWN_MAX
);
let botScansInFlight = 0;

/** Replace the interim message with a fresh final verdict (or a short error) at the bottom of the chat. Never throws. */
async function finishVerdict(
  chatId: string,
  interimMessageId: number,
  replyToMessageId: number | undefined,
  mint: string,
  outcome: MintScanOutcome | null
): Promise<void> {
  try {
    if (outcome?.ok) {
      const site = siteUrl();
      await replaceChatMessage(
        chatId,
        interimMessageId,
        formatMintVerdict(mint, outcome.payload, site),
        {
          replyToMessageId,
          // Unfurl the OGfinder share link into its og:image verdict card.
          linkPreviewUrl: verdictShareUrl(mint, outcome.payload, site),
        }
      );
    } else {
      await replaceChatMessage(
        chatId,
        interimMessageId,
        "🔍 <b>Couldn't verify this mint</b>\n\nNot found on-chain · or upstream APIs are down.",
        { replyToMessageId }
      );
    }
  } catch {
    /* verdict delivery is best-effort */
  }
}

/**
 * Instant registry-backed answer: resolve the pasted mint's name cheaply
 * (getAssetBatch is heliusMeta-cached — repeats are free), look up the EXACT
 * name skeleton in the OG registry, and on a fresh hit replace the placeholder
 * with a registry verdict at the bottom of the chat. Returns the new message
 * id (which the final verdict replaces in turn), or null when the registry had
 * no fresh answer. Deliberately awaited BEFORE the detached full scan starts
 * so the definitive verdict always lands after (and wins over) this one.
 */
async function sendRegistryPreVerdict(
  chatId: string,
  placeholderId: number,
  replyToMessageId: number | undefined,
  mint: string
): Promise<number | null> {
  try {
    const meta = (await getAssetBatch([mint])).get(mint);
    const name = meta?.heliusName?.trim();
    if (!name) return null;
    const key = skeleton(name);
    if (key.length < 2) return null;
    const entry = getRegisteredOg(key);
    if (!entry || !isRegistryFresh(entry.verifiedAt)) return null;
    return await replaceChatMessage(
      chatId,
      placeholderId,
      formatRegistryVerdict(mint, entry),
      { replyToMessageId }
    );
  } catch {
    /* registry pre-answer is best-effort — the full scan still replies */
    return null;
  }
}

/** Busy-cap check + placeholder + detached scan for one mint. */
async function startVerdictScan(
  chatId: string,
  replyToMessageId: number | undefined,
  mint: string
): Promise<void> {
  if (botScansInFlight >= MAX_CONCURRENT_BOT_SCANS) {
    await sendChatMessage(chatId, "⏳ <b>Busy</b> · try again in a moment", {
      replyToMessageId,
    });
    return;
  }
  const placeholderId = await sendChatMessage(
    chatId,
    "🔍 Checking if this is the OG…",
    { replyToMessageId }
  );
  if (placeholderId == null) return;
  // Instant answer for exact names we've already verified — awaited so the
  // detached full scan's reply below always lands later and wins. When it
  // fires, the placeholder is already replaced; the final verdict then
  // replaces the registry message.
  const registryMsgId = await sendRegistryPreVerdict(
    chatId,
    placeholderId,
    replyToMessageId,
    mint
  );
  const interimId = registryMsgId ?? placeholderId;
  // Detached on purpose: the long-poll loop stays responsive while the scan
  // runs; botScansInFlight bounds total concurrent pipeline work. scanMint
  // shares caches + in-flight coalescing with web scans, so warm mints are
  // near-instant.
  botScansInFlight++;
  void scanMint(mint)
    .then(
      (outcome) =>
        finishVerdict(chatId, interimId, replyToMessageId, mint, outcome),
      () => finishVerdict(chatId, interimId, replyToMessageId, mint, null)
    )
    .finally(() => {
      botScansInFlight--;
    });
}

async function handleCandidateMints(
  chatId: string,
  replyToMessageId: number | undefined,
  text: string
): Promise<void> {
  for (const mint of extractMintCandidates(text)) {
    if (verdictCooldown.check(chatId, mint)) continue;
    await startVerdictScan(chatId, replyToMessageId, mint);
  }
}

// ————————————————————— /og name mode: fast text search —————————————————————

/**
 * Text-search fast phase with the SAME cache keys and coalescing as the
 * route's phase=fast path (full 'normalized' cache first, then 'fast:'), so
 * bot and web searches of one name never duplicate pipeline work. No rate
 * limiting by design — bounding is botScansInFlight at the call site.
 */
async function runNameSearch(q: string): Promise<TokenResult[]> {
  const normalizedQuery = normalize(q);
  const cached = getSearchCache<TokenResult[]>(normalizedQuery);
  if (cached) return cached;
  const fastKey = `fast:${normalizedQuery}`;
  const cachedFast = getSearchCache<TokenResult[]>(fastKey);
  if (cachedFast) return cachedFast;
  return coalesce(fastKey, async () => {
    const rawTokens = await searchTokens(q);
    if (rawTokens.length === 0) {
      setSearchCache(fastKey, [] as TokenResult[], FAST_TTL);
      return [] as TokenResult[];
    }
    const results = await buildTokenResults(rawTokens, q, {
      skipSignatureScan: true,
    });
    setSearchCache(fastKey, results, FAST_TTL);
    return results;
  });
}

/**
 * Compact reply for /og <name>: top pick + up to 2 runners-up + the OGfinder
 * search link. Fast-phase ages are best-known, not verified — the label says
 * so honestly. Pure; exported for tests.
 */
export function formatNameSearchReply(
  query: string,
  results: TokenResult[],
  site: string
): string {
  const link = `${site}/?q=${encodeURIComponent(query)}`;
  if (results.length === 0) {
    // Same quote style and " · " separator as every other row in this reply.
    return `🔎 No tokens found named “${escapeHtml(query)}” · <a href="${link}">search on OGfinder</a>`;
  }
  const minted = (t: TokenResult): string => {
    const d = formatShareDate(t.createdAt);
    if (!d) return "age unknown";
    const ago = timeAgo(t.createdAt);
    // Same rule as the mint verdict: a truncated walk is a bound, so the date
    // gets "on or before" and the age becomes a minimum.
    if (t.createdAtIsLowerBound) {
      return `minted on or before ${d}${ago ? ` · at least ${ago}` : ""}`;
    }
    return `minted ${d}${ago ? ` · ${ago}` : ""}`;
  };
  // The same gate as formatMintVerdict, on the same pure helper: a list whose
  // #1 could be overturned by an unresolved age never gets the crown here
  // either. Fast-phase ages make this common — which is the honest outcome.
  const order = ageOrderConfidence(results);
  const top = results[0];
  const topSym = top.displaySymbol
    ? ` ($${escapeHtml(top.displaySymbol)})`
    : "";
  // Same three-block layout as the mint verdict: headline, the pick as its own
  // quoted card, then the runners-up and the footer.
  const blocks: string[] = [];
  const headline: string[] = [];
  let pickLabel = "Likely OG";
  // The pick card below is THE SAME TOKEN the headline just judged, so its
  // glyph tracks the headline: the crown appears only on the branch that
  // actually endorses. Withholding the crown in the headline and then printing
  // it one line later would hand back the endorsement we just refused.
  let pickGlyph = "👑";
  if (top.safetyLevel === "danger") {
    // Same rule as the mint verdict: the oldest match keeps its rank and loses
    // the crown. buildTokenResults assesses the rank-1 candidate on every
    // ranking path, so this fires on the text path too.
    headline.push(UNSAFE_HEADLINE);
    const blocking = formatBlockingFlagLine(top);
    if (blocking) headline.push(blocking);
    headline.push(`🕰 ${UNSAFE_RANK1_LINE}`);
    pickLabel = "Oldest match";
    pickGlyph = "🕰";
  } else if (!order.proven) {
    headline.push(
      `${UNPROVEN_HEADLINE} · ${formatUnprovenSuffix(order.unresolvedCount)}`
    );
    pickLabel = "Oldest known";
    pickGlyph = "🕰";
  } else {
    // No crown here — it belongs to the pick in the quoted block below, and
    // printing it twice in one message reads as clutter.
    headline.push(`🔎 <b>OLDEST MATCH FOR “${escapeHtml(query)}”</b>`);
  }
  blocks.push(headline.join("\n"));

  blocks.push(
    `<blockquote>${pickGlyph} <b>${pickLabel}: ${escapeHtml(top.displayName)}</b>${topSym}\n` +
      `📅 ${minted(top)}\n` +
      `<code>${escapeHtml(top.mint)}</code></blockquote>`
  );

  const runners = results.slice(1, 3);
  if (runners.length > 0) {
    blocks.push(
      runners
        .map((t) => {
          const sym = t.displaySymbol ? ` ($${escapeHtml(t.displaySymbol)})` : "";
          return `#${t.rank} ${escapeHtml(t.displayName)}${sym} · ${minted(t)}`;
        })
        .join("\n")
    );
  }

  blocks.push(
    `${results.length} token${results.length === 1 ? "" : "s"} by best-known age · <a href="${link}">verify on OGfinder</a>`
  );
  const lines = [blocks.join("\n\n")];
  return lines.join("\n");
}

/** Replace the name-search placeholder with the result list (or a short error) at the bottom of the chat. */
async function finishNameSearch(
  chatId: string,
  interimMessageId: number,
  replyToMessageId: number | undefined,
  query: string,
  results: TokenResult[] | null
): Promise<void> {
  try {
    if (results) {
      await replaceChatMessage(
        chatId,
        interimMessageId,
        formatNameSearchReply(query, results, siteUrl()),
        { replyToMessageId }
      );
    } else {
      await replaceChatMessage(
        chatId,
        interimMessageId,
        "🔍 <b>Search failed</b>\n\nUpstream APIs down · try again shortly.",
        { replyToMessageId }
      );
    }
  } catch {
    /* result delivery is best-effort */
  }
}

// ————————————————————————— Group registry —————————————————————————

/**
 * Posted once when the bot joins a group. Same block layout as the verdicts —
 * headline, what it does, the commands, and the honesty note as its own last
 * block so the one claim people misread is never buried mid-paragraph.
 * Exported for tests (pure constant).
 */
export const WELCOME_HTML = [
  "👑 <b>OGfinder is live in this chat</b>",
  "Paste any Solana CA and I'll check whether it's the original token of " +
    "that name — age rank, market data, and the checks that decide it: mint " +
    "and freeze authority, Token-2022 transfer hooks and fees, and 24h buys " +
    "vs sells.",
  [
    "/og &lt;mint or name&gt; — OG-check a CA or a token name",
    "/watch &lt;name&gt; — new-clone alerts for a name in this chat",
    "/help — everything I check, in detail",
  ].join("\n"),
  "<i>An OG verdict means ORIGINAL BY AGE — that a mint came first, not that " +
    "it is safe to buy, and never investment advice. A token with a blocking " +
    "flag is never called the OG here.</i>",
].join("\n\n");

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

/**
 * A command arriving from a group proves membership (kicked bots receive
 * nothing), so groups added before membership tracking existed self-register
 * on their first command. welcome_sent starts at 1 — they're already using
 * commands, a welcome would be noise.
 */
function ensureGroupRegistered(chat: TelegramChat, chatId: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO telegram_groups (chat_id, title, added_at, welcome_sent, active)
         VALUES (?, ?, ?, 1, 1)
         ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, active = 1`
      )
      .run(chatId, chat.title ?? null, Date.now());
  } catch {
    /* registry is best-effort — the command still runs */
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

// ————————————————————— Group/DM command handlers —————————————————————

/**
 * /help. Blocks, not a wall: headline, commands, the paste-a-CA behaviour,
 * what gets checked, what the verdict does and does not mean, and last the
 * privacy note that unblocks a silent group. Exported for tests (pure).
 */
export const HELP_HTML = [
  "<b>OGfinder bot</b> — which token of a name came first.",
  [
    "/og &lt;mint or name&gt; — OG-check a CA or a token name",
    "/watch &lt;name&gt; — new-clone alerts for a name in this chat (25/day cap)",
    "/watches — list this chat's watches",
    "/unwatch &lt;id or name&gt; — remove a watch",
    "/help — this message",
  ].join("\n"),
  "Paste any Solana CA straight into the chat and I'll check it " +
    "automatically — no command needed.",
  "<b>What I check:</b> on-chain age (which mint came first), mint and freeze " +
    "authority, Token-2022 extensions (transfer hooks, permanent delegate, " +
    "transfer fees), 24h buys vs sells, holder concentration and liquidity.",
  "<b>What an OG verdict means:</b> ORIGINALITY BY AGE — that this mint came " +
    "first, not that it is safe to buy. A token with a blocking flag (freeze " +
    "authority, transfer hook, buys with no sells…) is never called the OG " +
    "here, and a check I couldn't run is reported as unavailable, never as " +
    "clean. None of this is investment advice — always do your own research.",
  "<i>If pasted CAs get no reply here, the bot can't see plain group " +
    "messages — ask the group owner to disable bot privacy via @BotFather " +
    "(/setprivacy → Disable), then re-add me.</i>",
].join("\n\n");

async function handleOg(
  chatId: string,
  replyToMessageId: number | undefined,
  arg: string | null
): Promise<void> {
  if (!arg) {
    await reply(chatId, "Usage: /og &lt;mint address or token name&gt;");
    return;
  }
  // Bare mint or a mint inside a pasted URL → full verdict flow.
  const mint = isLikelyMintAddress(arg) ? arg : extractMintCandidates(arg, 1)[0];
  if (mint) {
    // Explicit ask: record the cooldown (dedupes later plain pastes of the
    // same CA) but never skip on it — /og always answers.
    verdictCooldown.check(chatId, mint);
    await startVerdictScan(chatId, replyToMessageId, mint);
    return;
  }
  if (arg.length < MIN_QUERY || arg.length > MAX_QUERY) {
    await reply(
      chatId,
      `Token names are ${MIN_QUERY}-${MAX_QUERY} characters · or paste a full mint address.`
    );
    return;
  }
  if (botScansInFlight >= MAX_CONCURRENT_BOT_SCANS) {
    await sendChatMessage(chatId, "⏳ <b>Busy</b> · try again in a moment", {
      replyToMessageId,
    });
    return;
  }
  const placeholderId = await sendChatMessage(
    chatId,
    `🔍 Ranking lookalikes of “${escapeHtml(arg)}” by age…`,
    { replyToMessageId }
  );
  if (placeholderId == null) return;
  // Same detached pattern as verdict scans — the loop stays responsive.
  botScansInFlight++;
  void runNameSearch(arg)
    .then(
      (results) =>
        finishNameSearch(chatId, placeholderId, replyToMessageId, arg, results),
      () => finishNameSearch(chatId, placeholderId, replyToMessageId, arg, null)
    )
    .finally(() => {
      botScansInFlight--;
    });
}

async function handleWatch(chatId: string, arg: string | null): Promise<void> {
  if (!arg) {
    await reply(
      chatId,
      "Usage: /watch &lt;token name&gt; · e.g. /watch bonk\n\nNew-clone alerts land in this chat."
    );
    return;
  }
  let result: CreateWatchResult;
  try {
    result = createWatch({
      query: arg,
      ip: telegramWatchIpKey(chatId),
      telegramChatId: chatId,
    });
  } catch {
    await reply(chatId, "Couldn't create the watch · try again shortly.");
    return;
  }
  if (!result.ok) {
    const msg =
      result.error === "invalid"
        ? "Watch names are 2-30 characters with at least 2 letters/numbers."
        : result.error === "limit"
          ? "This chat already has 10 watches · /unwatch one first."
          : "Watch capacity is full right now · try again later.";
    await reply(chatId, msg);
    return;
  }
  const w = result.watch;
  await reply(
    chatId,
    w.existing
      ? `👀 Already watching <b>${escapeHtml(w.displayQuery)}</b> (#${w.id}) in this chat.`
      : [
          `👀 <b>Watching ${escapeHtml(w.displayQuery)}</b> (#${w.id})`,
          `New-clone alerts land here · 25/day cap · /unwatch ${w.id} to stop.`,
        ].join("\n\n")
  );
}

async function handleWatches(chatId: string): Promise<void> {
  let rows: ReturnType<typeof listWatchesForTelegramChat>;
  try {
    rows = listWatchesForTelegramChat(chatId);
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    await reply(
      chatId,
      "No watches in this chat · /watch &lt;name&gt; to add one."
    );
    return;
  }
  const lines = rows.map((r) => {
    const ago = timeAgo(new Date(r.createdAt).toISOString());
    return `#${r.id} · <b>${escapeHtml(r.displayQuery)}</b>${ago ? ` · ${ago}` : ""}`;
  });
  await reply(
    chatId,
    [
      "👀 <b>Watches in this chat</b>",
      lines.join("\n"),
      "/unwatch &lt;id or name&gt; to remove.",
    ].join("\n\n")
  );
}

async function handleUnwatch(chatId: string, arg: string | null): Promise<void> {
  if (!arg) {
    await reply(chatId, "Usage: /unwatch &lt;id or name&gt; · /watches lists them.");
    return;
  }
  let removed = 0;
  try {
    removed = unwatchForTelegramChat(chatId, arg);
  } catch {
    removed = 0;
  }
  await reply(
    chatId,
    removed > 0
      ? `✅ Removed ${removed} watch${removed === 1 ? "" : "es"}.`
      : `No watch matching “${escapeHtml(arg)}” in this chat · /watches lists them.`
  );
}

async function handleBotCommand(
  chatId: string,
  replyToMessageId: number | undefined,
  cmd: BotCommand
): Promise<void> {
  switch (cmd.command) {
    case "og":
      await handleOg(chatId, replyToMessageId, cmd.arg);
      return;
    case "watch":
      await handleWatch(chatId, cmd.arg);
      return;
    case "watches":
      await handleWatches(chatId);
      return;
    case "unwatch":
      await handleUnwatch(chatId, cmd.arg);
      return;
    case "help":
      await reply(chatId, HELP_HTML);
      return;
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
      const legacy = parseTelegramCommand(text);
      if (legacy) {
        if (legacy.command === "start") await handleStart(chatId, legacy.arg);
        else if (legacy.command === "stop") await handleStop(chatId);
        else await handleList(chatId);
        return;
      }
      const cmd = parseBotCommand(text);
      if (cmd) {
        if (await commandIsForThisBot(cmd.mention)) {
          await handleBotCommand(chatId, msg.message_id, cmd);
        }
        return;
      }
      await handleCandidateMints(chatId, msg.message_id, text);
      return;
    }
    if (chatType === "group" || chatType === "supergroup") {
      // Commands run even in not-yet-registered groups (privacy mode delivers
      // them regardless) and self-register the group as a side effect.
      const cmd = parseBotCommand(text);
      if (cmd) {
        if (!(await commandIsForThisBot(cmd.mention))) return;
        ensureGroupRegistered(msg.chat ?? {}, chatId);
        await handleBotCommand(chatId, msg.message_id, cmd);
        return;
      }
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

/**
 * Command menu registration — bump the version when TG_COMMANDS changes so
 * the next boot re-registers; otherwise the poll_state guard makes this a
 * once-ever no-op (setMyCommands is rate-limited, don't call it every boot).
 */
const TG_COMMANDS_VERSION = "1";
const TG_COMMANDS = [
  { command: "og", description: "OG-check a mint address or token name" },
  { command: "watch", description: "New-clone alerts for a name in this chat" },
  { command: "watches", description: "List this chat's watches" },
  { command: "unwatch", description: "Remove a watch by id or name" },
  { command: "help", description: "Commands and how CA checks work" },
];

async function registerBotCommands(): Promise<void> {
  try {
    if (getPollState("tg:commands_set") === TG_COMMANDS_VERSION) return;
  } catch {
    /* poll_state unavailable — attempt registration anyway */
  }
  try {
    const res = (await tgCall("setMyCommands", { commands: TG_COMMANDS })) as {
      ok?: boolean;
    } | null;
    if (res?.ok) {
      try {
        setPollState("tg:commands_set", TG_COMMANDS_VERSION);
      } catch {
        /* best-effort — worst case one extra setMyCommands next boot */
      }
    }
  } catch {
    /* retried on next boot */
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
  // Register the command menu once per boot (poll_state-guarded, detached).
  void registerBotCommands();
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
