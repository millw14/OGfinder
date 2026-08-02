import {
  TgUpdate,
  TgMessage,
  TgCallbackQuery,
  TgInlineQuery,
  TgInlineQueryResultArticle,
} from "./bot-types";
import { TelegramClient, TelegramApiError } from "./telegram";
import { BotStore, MAX_WATCHES_PER_CHAT } from "./store";
import { BotConfig } from "./config";
import {
  detectAddresses,
  isValidSolanaAddress,
  MAX_ADDRESSES_PER_MESSAGE,
} from "./detect";
import {
  verdictMessage,
  topListMessage,
  compareMessage,
  walletMessage,
  helpMessage,
  startMessage,
  inlineTokenCard,
  escapeHtml,
  truncateMint,
  fmtUsd,
} from "./format";
import {
  scanMintCached,
  searchByNameCached,
  ScanVerdict,
} from "../lib/scan-core";
import { MIN_QUERY, MAX_QUERY, WalletAnalysis } from "../lib/types";
import { consumeRateLimit } from "../lib/rate-limit";
import { fetchWithTimeout } from "../lib/fetch";
import { getWalletCache, setWalletCache } from "../lib/cache";
import { analyzeWallet } from "../lib/wallet-analysis";
import { normalize } from "../lib/normalize";

/** Per-chat auto-scan budget: sustained 6/min, bursts of 4. */
const CHAT_SCAN_RATE = { ratePerMin: 6, burst: 4 };
/** Skip re-announcing the same mint in the same chat within this window. */
const DEDUPE_WINDOW_MS = 90_000;
/** Inline queries must answer fast; give the pipeline this long. */
const INLINE_BUDGET_MS = 8_000;

const DEX_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana";
const DEX_PAIR_URL = "https://api.dexscreener.com/latest/dex/pairs/solana";
const DEX_BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";

interface DexTokenPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

export interface TokenSnapshot {
  mint: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

/** Best (highest-liquidity) pair snapshot per mint via DexScreener batch API. */
export async function fetchTokenSnapshots(
  mints: string[]
): Promise<Map<string, TokenSnapshot>> {
  const out = new Map<string, TokenSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const data = (await fetchWithTimeout(
        `${DEX_TOKENS_URL}/${chunk.join(",")}`,
        8000
      )) as DexTokenPair[];
      if (!Array.isArray(data)) continue;
      for (const p of data) {
        const mint = p.baseToken?.address;
        if (!mint || p.chainId !== "solana") continue;
        const liq = typeof p.liquidity?.usd === "number" ? p.liquidity.usd : null;
        const prev = out.get(mint);
        if (prev && (prev.liquidityUsd ?? -1) >= (liq ?? -1)) continue;
        const price = Number(p.priceUsd);
        out.set(mint, {
          mint,
          name: p.baseToken?.name ?? null,
          symbol: p.baseToken?.symbol ?? null,
          priceUsd: Number.isFinite(price) && price > 0 ? price : null,
          liquidityUsd: liq,
          marketCapUsd:
            typeof p.marketCap === "number"
              ? p.marketCap
              : typeof p.fdv === "number"
                ? p.fdv
                : null,
        });
      }
    } catch {
      /* chunk unavailable */
    }
  }
  return out;
}

/** DexScreener pair (pool) address → base token mint. */
async function resolvePairBaseMint(pair: string): Promise<string | null> {
  try {
    const data = (await fetchWithTimeout(
      `${DEX_PAIR_URL}/${pair}`,
      8000
    )) as { pairs?: DexTokenPair[] | null; pair?: DexTokenPair | null };
    const p = data.pairs?.[0] ?? data.pair;
    const mint = p?.baseToken?.address;
    return mint && isValidSolanaAddress(mint) ? mint : null;
  } catch {
    return null;
  }
}

function chunkCommand(
  text: string
): { cmd: string; mention: string | null; args: string } | null {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), mention: m[2] ?? null, args: (m[3] ?? "").trim() };
}

export class BotHandlers {
  private recentScans = new Map<string, number>();

  constructor(
    private readonly tg: TelegramClient,
    private readonly store: BotStore,
    private readonly cfg: BotConfig,
    private readonly botUsername: string,
    private readonly botId: number
  ) {
    tg.onChatMigrated = (oldId, newId) => {
      try {
        this.store.migrateChat(oldId, newId);
      } catch (err) {
        console.warn("[bot] chat migration persist failed:", err);
      }
    };
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    try {
      if (u.message) await this.handleMessage(u.message);
      else if (u.channel_post) await this.handleMessage(u.channel_post);
      else if (u.callback_query) await this.handleCallback(u.callback_query);
      else if (u.inline_query) await this.handleInline(u.inline_query);
    } catch (err) {
      console.error("[bot] update failed:", err);
    }
  }

  // ── Messages ────────────────────────────────────────────────────

  private async handleMessage(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;

    if (msg.migrate_to_chat_id) {
      this.store.migrateChat(chatId, msg.migrate_to_chat_id);
      return;
    }

    // Greet groups when the bot itself is added.
    if (msg.new_chat_members?.some((m) => m.id === this.botId)) {
      await this.safeSend(chatId, null, helpMessage(this.botUsername, this.cfg.siteUrl));
      return;
    }

    const text = msg.text ?? msg.caption ?? "";
    if (!text) return;

    const command = text.startsWith("/") ? chunkCommand(text) : null;
    if (command) {
      // In groups, ignore commands addressed to another bot.
      if (
        command.mention &&
        command.mention.toLowerCase() !== this.botUsername.toLowerCase()
      ) {
        return;
      }
      await this.handleCommand(msg, command.cmd, command.args);
      return;
    }

    await this.handleAutoScan(msg, text);
  }

  private async handleCommand(
    msg: TgMessage,
    cmd: string,
    args: string
  ): Promise<void> {
    const chatId = msg.chat.id;
    switch (cmd) {
      case "start": {
        const { text, keyboard } = startMessage(this.botUsername, this.cfg.siteUrl);
        await this.safeSend(chatId, null, text, keyboard);
        return;
      }
      case "help": {
        await this.safeSend(
          chatId,
          msg.message_id,
          helpMessage(this.botUsername, this.cfg.siteUrl)
        );
        return;
      }
      case "og":
      case "check":
      case "scan": {
        let target = args;
        if (!target && msg.reply_to_message) {
          const replyText =
            msg.reply_to_message.text ?? msg.reply_to_message.caption ?? "";
          const found = detectAddresses(replyText);
          target = found.mints[0] ?? "";
        }
        if (!target) {
          await this.safeSend(
            chatId,
            msg.message_id,
            "Usage: <code>/og &lt;CA or token name&gt;</code> — or reply /og to a message containing a CA."
          );
          return;
        }
        if (isValidSolanaAddress(target)) {
          await this.scanAndReply(chatId, msg.message_id, target, {
            quiet: false,
          });
        } else {
          await this.nameSearchReply(msg, target);
        }
        return;
      }
      case "search":
      case "find": {
        if (!args) {
          await this.safeSend(
            chatId,
            msg.message_id,
            "Usage: <code>/search &lt;token name&gt;</code>"
          );
          return;
        }
        await this.nameSearchReply(msg, args);
        return;
      }
      case "compare":
      case "vs": {
        const addrs = (args.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []).filter(
          isValidSolanaAddress
        );
        if (addrs.length < 2) {
          await this.safeSend(
            chatId,
            msg.message_id,
            "Usage: <code>/compare &lt;CA&gt; &lt;CA&gt;</code> — two Solana mints, head-to-head."
          );
          return;
        }
        await this.compareAndReply(chatId, msg.message_id, addrs[0], addrs[1]);
        return;
      }
      case "wallet": {
        const addr = args.trim();
        if (!isValidSolanaAddress(addr)) {
          await this.safeSend(
            chatId,
            msg.message_id,
            "Usage: <code>/wallet &lt;Solana wallet address&gt;</code>"
          );
          return;
        }
        await this.walletAndReply(chatId, msg.message_id, addr);
        return;
      }
      case "trending": {
        await this.trendingReply(chatId, msg.message_id);
        return;
      }
      case "watch": {
        const addr = args.trim();
        if (!isValidSolanaAddress(addr)) {
          await this.safeSend(
            chatId,
            msg.message_id,
            "Usage: <code>/watch &lt;CA&gt;</code> — price &amp; rug alerts in this chat."
          );
          return;
        }
        await this.addWatchReply(msg, addr);
        return;
      }
      case "unwatch": {
        const addr = args.trim();
        const removed = isValidSolanaAddress(addr) && this.store.removeWatch(chatId, addr);
        await this.safeSend(
          chatId,
          msg.message_id,
          removed
            ? `🗑 Stopped watching <code>${escapeHtml(truncateMint(addr))}</code>.`
            : "Nothing removed — <code>/watchlist</code> shows what this chat watches."
        );
        return;
      }
      case "watchlist": {
        await this.watchlistReply(chatId, msg.message_id);
        return;
      }
      case "settings": {
        await this.settingsReply(msg);
        return;
      }
      case "stats": {
        const s = this.store.chatStats(chatId);
        const rate =
          s.scans > 0 ? Math.round((s.ogCount / s.scans) * 100) : 0;
        const lines = [
          `📊 <b>This chat's scan stats</b>`,
          `🔬 Scans: ${s.scans} · 🏆 OG verdicts: ${s.ogCount} (${rate}%)`,
        ];
        if (s.topMints.length > 0) {
          lines.push("");
          lines.push("Most scanned:");
          for (const t of s.topMints) {
            lines.push(
              `• ${escapeHtml(t.name ?? truncateMint(t.mint))} — ${t.count}×`
            );
          }
        }
        await this.safeSend(chatId, msg.message_id, lines.join("\n"));
        return;
      }
      case "ping": {
        const started = Date.now();
        await this.tg.sendChatAction(chatId).catch(() => undefined);
        const ms = Date.now() - started;
        await this.safeSend(
          chatId,
          msg.message_id,
          `🏓 Alive. Telegram roundtrip ${ms}ms · ${
            process.env.HELIUS_API_KEY?.trim() ? "Helius ✅" : "Helius key missing ⚠️"
          }`
        );
        return;
      }
      default:
        // Unknown command — stay silent in groups, hint in private.
        if (msg.chat.type === "private") {
          await this.safeSend(chatId, null, "Unknown command — try /help.");
        }
    }
  }

  // ── Auto-scan ───────────────────────────────────────────────────

  private async handleAutoScan(msg: TgMessage, text: string): Promise<void> {
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === "private";

    const settings = this.store.getChatSettings(chatId);
    if (!isPrivate && !settings.autoscan) return;

    const detected = detectAddresses(text);
    let mints = [...detected.mints];

    // Resolve DexScreener/Photon pair links to their base mint.
    for (const pair of detected.pairAddresses) {
      if (mints.length >= MAX_ADDRESSES_PER_MESSAGE) break;
      const mint = await resolvePairBaseMint(pair);
      if (mint && !mints.includes(mint)) mints.push(mint);
    }
    mints = mints.slice(0, MAX_ADDRESSES_PER_MESSAGE);
    if (mints.length === 0) return;

    const now = Date.now();
    this.pruneRecent(now);
    mints = mints.filter((m) => {
      const key = `${chatId}:${m}`;
      const last = this.recentScans.get(key);
      if (last && now - last < DEDUPE_WINDOW_MS) return false;
      this.recentScans.set(key, now);
      return true;
    });
    if (mints.length === 0) return;

    // Per-chat budget so a CA spam wave can't flood the chat or the APIs.
    const gate = consumeRateLimit(`tg:${chatId}`, CHAT_SCAN_RATE);
    if (!gate.allowed) return;

    const quiet = !isPrivate && settings.quiet;
    for (const mint of mints) {
      await this.scanAndReply(chatId, msg.message_id, mint, { quiet });
    }
  }

  private pruneRecent(now: number): void {
    if (this.recentScans.size < 512) return;
    this.recentScans.forEach((ts, key) => {
      if (now - ts > DEDUPE_WINDOW_MS) this.recentScans.delete(key);
    });
  }

  // ── Scan / reply flows ──────────────────────────────────────────

  /**
   * The core group flow: placeholder → pipeline → verdict card (edit).
   * In quiet mode nothing is sent unless the verdict is NOT the OG.
   */
  private async scanAndReply(
    chatId: number,
    replyTo: number | null,
    mint: string,
    opts: { quiet: boolean }
  ): Promise<void> {
    let placeholderId: number | null = null;
    if (!opts.quiet) {
      const ph = await this.safeSend(
        chatId,
        replyTo,
        `🔎 Scanning <code>${escapeHtml(truncateMint(mint))}</code> — checking if it's the OG…`
      );
      placeholderId = ph?.message_id ?? null;
    }

    const outcome = await scanMintCached(mint);

    if (!outcome.ok) {
      const errText = `😕 <code>${escapeHtml(truncateMint(mint))}</code> — ${escapeHtml(outcome.error)}`;
      if (placeholderId != null) {
        await this.safeEdit(chatId, placeholderId, errText);
      }
      // Quiet mode: failures stay silent.
      return;
    }

    const v = outcome.verdict;
    this.store.recordScan(
      chatId,
      mint,
      v.scanName ?? v.scanned?.displayName ?? null,
      v.isScannedOG,
      v.scannedRank,
      v.totalFound
    );

    if (opts.quiet && v.isScannedOG) {
      return; // quiet mode only surfaces non-OG (copycat) verdicts
    }

    const { text, keyboard } = verdictMessage(v, this.cfg.siteUrl);
    if (placeholderId != null) {
      await this.safeEdit(chatId, placeholderId, text, keyboard);
    } else {
      await this.safeSend(chatId, replyTo, text, keyboard);
    }
  }

  private async nameSearchReply(msg: TgMessage, query: string): Promise<void> {
    const chatId = msg.chat.id;
    const q = query.trim();
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
      await this.safeSend(
        chatId,
        msg.message_id,
        `Name search needs ${MIN_QUERY}-${MAX_QUERY} characters.`
      );
      return;
    }
    const ph = await this.safeSend(
      chatId,
      msg.message_id,
      `🔎 Ranking every "<b>${escapeHtml(q)}</b>" on Solana by on-chain age…`
    );
    const results = await searchByNameCached(q);
    if (results.length === 0) {
      if (ph) {
        await this.safeEdit(
          chatId,
          ph.message_id,
          `😕 No Solana tokens found matching "<b>${escapeHtml(q)}</b>".`
        );
      }
      return;
    }
    const { text, keyboard } = topListMessage(
      results,
      normalize(q),
      results.length,
      5,
      this.cfg.siteUrl
    );
    if (ph) await this.safeEdit(chatId, ph.message_id, text, keyboard);
  }

  private async compareAndReply(
    chatId: number,
    replyTo: number,
    a: string,
    b: string
  ): Promise<void> {
    const ph = await this.safeSend(
      chatId,
      replyTo,
      `⚔️ Scanning both contracts — oldest wins…`
    );
    const [ra, rb] = await Promise.all([scanMintCached(a), scanMintCached(b)]);
    if (!ra.ok || !rb.ok) {
      const bad = !ra.ok
        ? `A (${truncateMint(a)}): ${!ra.ok ? ra.error : ""}`
        : `B (${truncateMint(b)}): ${!rb.ok ? rb.error : ""}`;
      if (ph) {
        await this.safeEdit(chatId, ph.message_id, `😕 Compare failed — ${escapeHtml(bad)}`);
      }
      return;
    }
    const { text, keyboard } = compareMessage(ra.verdict, rb.verdict, this.cfg.siteUrl);
    if (ph) await this.safeEdit(chatId, ph.message_id, text, keyboard);
  }

  private async walletAndReply(
    chatId: number,
    replyTo: number,
    address: string
  ): Promise<void> {
    if (!process.env.HELIUS_API_KEY?.trim()) {
      await this.safeSend(
        chatId,
        replyTo,
        "👛 Wallet analysis needs a HELIUS_API_KEY on the server — ask the operator to set it."
      );
      return;
    }
    const ph = await this.safeSend(
      chatId,
      replyTo,
      `👛 Analyzing <code>${escapeHtml(truncateMint(address))}</code> — trades, PnL, side wallets…`
    );
    try {
      const cacheKey = `wallet:${address}`;
      let analysis = getWalletCache<WalletAnalysis>(cacheKey);
      if (!analysis) {
        analysis = await analyzeWallet(address);
        setWalletCache(cacheKey, analysis);
      }
      const { text, keyboard } = walletMessage(analysis, this.cfg.siteUrl);
      if (ph) await this.safeEdit(chatId, ph.message_id, text, keyboard);
    } catch (err) {
      console.error("[bot] wallet analysis failed:", err);
      if (ph) {
        await this.safeEdit(
          chatId,
          ph.message_id,
          "😕 Wallet analysis failed — try again in a minute."
        );
      }
    }
  }

  private async trendingReply(chatId: number, replyTo: number): Promise<void> {
    const ph = await this.safeSend(
      chatId,
      replyTo,
      "🔥 Fetching boosted Solana tokens…"
    );
    try {
      const data = (await fetchWithTimeout(DEX_BOOSTS_URL, 8000)) as Array<{
        chainId?: string;
        tokenAddress?: string;
      }>;
      const mints: string[] = [];
      for (const t of Array.isArray(data) ? data : []) {
        if (t.chainId !== "solana" || !t.tokenAddress) continue;
        if (!isValidSolanaAddress(t.tokenAddress)) continue;
        if (!mints.includes(t.tokenAddress)) mints.push(t.tokenAddress);
        if (mints.length >= 8) break;
      }
      if (mints.length === 0) {
        if (ph) {
          await this.safeEdit(chatId, ph.message_id, "😕 No boosted Solana tokens right now.");
        }
        return;
      }
      const snaps = await fetchTokenSnapshots(mints);
      const lines = ["🔥 <b>Boosted on DexScreener right now</b>", ""];
      const buttons = [];
      let i = 1;
      for (const mint of mints) {
        const s = snaps.get(mint);
        const label = s?.name
          ? `${escapeHtml(s.name)}${s.symbol ? ` ($${escapeHtml(s.symbol)})` : ""}`
          : `<code>${escapeHtml(truncateMint(mint))}</code>`;
        const bits = [
          fmtUsd(s?.priceUsd ?? null),
          s?.marketCapUsd != null ? `MC ${fmtUsd(s.marketCapUsd)}` : null,
        ].filter(Boolean);
        lines.push(`${i}. ${label}${bits.length ? ` — ${bits.join(" · ")}` : ""}`);
        buttons.push({
          text: `🔬 ${i}. ${s?.symbol ? `$${s.symbol}` : truncateMint(mint).slice(0, 10)}`,
          callback_data: `scan:${mint}`,
        });
        i++;
      }
      lines.push("");
      lines.push("Boosted ≠ legit — tap to check who's the OG.");
      const keyboard = [];
      for (let j = 0; j < buttons.length; j += 2) {
        keyboard.push(buttons.slice(j, j + 2));
      }
      if (ph) {
        await this.safeEdit(chatId, ph.message_id, lines.join("\n"), keyboard);
      }
    } catch (err) {
      console.error("[bot] trending failed:", err);
      if (ph) {
        await this.safeEdit(chatId, ph.message_id, "😕 DexScreener boosts unavailable right now.");
      }
    }
  }

  private async addWatchReply(msg: TgMessage, mint: string): Promise<void> {
    const chatId = msg.chat.id;
    const snaps = await fetchTokenSnapshots([mint]);
    const s = snaps.get(mint) ?? null;
    const status = this.store.addWatch(
      chatId,
      mint,
      s?.symbol ?? null,
      msg.from?.id ?? 0,
      s?.priceUsd ?? null,
      s?.liquidityUsd ?? null
    );
    if (status === "full") {
      await this.safeSend(
        chatId,
        msg.message_id,
        `👀 This chat already watches ${MAX_WATCHES_PER_CHAT} tokens — /unwatch one first.`
      );
      return;
    }
    if (status === "exists") {
      await this.safeSend(chatId, msg.message_id, "👀 Already watching that one here.");
      return;
    }
    const label = s?.symbol ? `$${escapeHtml(s.symbol)}` : `<code>${escapeHtml(truncateMint(mint))}</code>`;
    const price = s?.priceUsd != null ? ` @ ${fmtUsd(s.priceUsd)}` : "";
    await this.safeSend(
      chatId,
      msg.message_id,
      `👀 Watching ${label}${price} — I'll shout on ±${this.cfg.watchAlertPct}% moves or a liquidity rug. Every ${Math.round(this.cfg.watchIntervalSec / 60)}min.`
    );
  }

  private async watchlistReply(chatId: number, replyTo: number): Promise<void> {
    const rows = this.store.listWatches(chatId);
    if (rows.length === 0) {
      await this.safeSend(
        chatId,
        replyTo,
        "👀 Nothing watched in this chat yet — <code>/watch &lt;CA&gt;</code> to start."
      );
      return;
    }
    const lines = [`👀 <b>Watched here</b> (${rows.length}/${MAX_WATCHES_PER_CHAT})`, ""];
    const keyboard = [];
    for (const r of rows) {
      const label = r.symbol ? `$${escapeHtml(r.symbol)}` : truncateMint(r.mint);
      const price = r.last_price != null ? ` — ${fmtUsd(r.last_price)}` : "";
      lines.push(`• ${label}${price}\n   <code>${escapeHtml(r.mint)}</code>`);
      keyboard.push([
        { text: `🗑 Unwatch ${r.symbol ? `$${r.symbol}` : truncateMint(r.mint).slice(0, 10)}`, callback_data: `w:rm:${r.mint}` },
      ]);
    }
    await this.safeSend(chatId, replyTo, lines.join("\n"), keyboard);
  }

  private async settingsReply(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id;
    if (msg.chat.type === "private") {
      await this.safeSend(
        chatId,
        msg.message_id,
        "Settings apply to groups — add me to one and run /settings there."
      );
      return;
    }
    if (!(await this.isAdmin(chatId, msg.from?.id))) {
      await this.safeSend(chatId, msg.message_id, "Only group admins can change my settings.");
      return;
    }
    const s = this.store.getChatSettings(chatId);
    await this.safeSend(
      chatId,
      msg.message_id,
      this.settingsText(s.autoscan, s.quiet),
      this.settingsKeyboard(s.autoscan, s.quiet)
    );
  }

  private settingsText(autoscan: boolean, quiet: boolean): string {
    return [
      "⚙️ <b>Group settings</b>",
      "",
      `🔬 Auto-scan CAs: <b>${autoscan ? "ON" : "OFF"}</b>`,
      `🤫 Quiet mode (only warn on non-OG): <b>${quiet ? "ON" : "OFF"}</b>`,
      "",
      "Quiet mode keeps the chat clean: I stay silent on OG-verified pastes and only speak up when something is NOT the original.",
    ].join("\n");
  }

  private settingsKeyboard(autoscan: boolean, quiet: boolean) {
    return [
      [
        {
          text: `${autoscan ? "🔴 Turn auto-scan OFF" : "🟢 Turn auto-scan ON"}`,
          callback_data: `set:autoscan:${autoscan ? 0 : 1}`,
        },
      ],
      [
        {
          text: `${quiet ? "🔊 Disable quiet mode" : "🤫 Enable quiet mode"}`,
          callback_data: `set:quiet:${quiet ? 0 : 1}`,
        },
      ],
    ];
  }

  private async isAdmin(
    chatId: number,
    userId: number | undefined
  ): Promise<boolean> {
    if (!userId) return false;
    try {
      const m = await this.tg.getChatMember(chatId, userId);
      return m.status === "creator" || m.status === "administrator";
    } catch {
      return false;
    }
  }

  // ── Callbacks ───────────────────────────────────────────────────

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const data = cq.data ?? "";
    const msg = cq.message;

    if (data.startsWith("t5:")) {
      const mint = data.slice(3);
      await this.tg.answerCallbackQuery(cq.id, "Ranking by age…").catch(() => undefined);
      if (!msg) return;
      const outcome = await scanMintCached(mint);
      if (!outcome.ok) return;
      const v = outcome.verdict;
      const { text, keyboard } = topListMessage(
        v.results,
        v.query,
        v.totalFound,
        5,
        this.cfg.siteUrl,
        mint
      );
      await this.safeSend(msg.chat.id, msg.message_id, text, keyboard);
      return;
    }

    if (data.startsWith("scan:")) {
      const mint = data.slice(5);
      await this.tg.answerCallbackQuery(cq.id, "Scanning…").catch(() => undefined);
      if (!msg) return;
      await this.scanAndReply(msg.chat.id, msg.message_id, mint, { quiet: false });
      return;
    }

    if (data.startsWith("set:")) {
      const [, key, val] = data.split(":");
      if (!msg || (key !== "autoscan" && key !== "quiet")) return;
      if (!(await this.isAdmin(msg.chat.id, cq.from.id))) {
        await this.tg
          .answerCallbackQuery(cq.id, "Admins only.", true)
          .catch(() => undefined);
        return;
      }
      const next = this.store.setChatSetting(
        msg.chat.id,
        key,
        val === "1"
      );
      await this.tg.answerCallbackQuery(cq.id, "Saved.").catch(() => undefined);
      await this.safeEdit(
        msg.chat.id,
        msg.message_id,
        this.settingsText(next.autoscan, next.quiet),
        this.settingsKeyboard(next.autoscan, next.quiet)
      );
      return;
    }

    if (data.startsWith("w:rm:")) {
      const mint = data.slice(5);
      if (!msg) return;
      const removed = this.store.removeWatch(msg.chat.id, mint);
      await this.tg
        .answerCallbackQuery(cq.id, removed ? "Unwatched." : "Was not watched.")
        .catch(() => undefined);
      return;
    }

    await this.tg.answerCallbackQuery(cq.id).catch(() => undefined);
  }

  // ── Inline mode ─────────────────────────────────────────────────

  private async handleInline(iq: TgInlineQuery): Promise<void> {
    const q = iq.query.trim();
    if (q.length < MIN_QUERY) {
      await this.tg.answerInlineQuery(iq.id, []).catch(() => undefined);
      return;
    }

    const budget = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([
        p,
        new Promise<null>((r) => setTimeout(() => r(null), INLINE_BUDGET_MS)),
      ]);

    const results: TgInlineQueryResultArticle[] = [];

    if (isValidSolanaAddress(q)) {
      const outcome = await budget(scanMintCached(q));
      if (outcome && outcome.ok) {
        const v = outcome.verdict;
        const { text, keyboard } = verdictMessage(v, this.cfg.siteUrl);
        const title = v.isScannedOG
          ? `🏆 OG — ${v.scanName ?? "token"}`
          : `❌ Not the OG — #${v.scannedRank ?? "?"} of ${v.totalFound}`;
        results.push({
          type: "article",
          id: `v:${v.scannedMint.slice(0, 40)}`,
          title,
          description: `${v.scanName ?? ""} ${v.scanSymbol ? `($${v.scanSymbol})` : ""} — tap to post the verdict`,
          input_message_content: {
            message_text: text,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
          ...(keyboard.length > 0
            ? { reply_markup: { inline_keyboard: keyboard } }
            : {}),
        });
      }
    } else if (q.length <= MAX_QUERY) {
      const found = await budget(searchByNameCached(q));
      const total = found?.length ?? 0;
      for (const t of (found ?? []).slice(0, 3)) {
        const rankTag = t.rank === 1 ? "👑 OG" : `#${t.rank} by age`;
        const body = inlineTokenCard(t, normalize(q), total, this.cfg.siteUrl);
        results.push({
          type: "article",
          id: `s:${t.mint.slice(0, 40)}`,
          title: `${rankTag} — ${t.displayName} ($${t.displaySymbol})`,
          description: `${t.createdAt ? new Date(t.createdAt).toDateString() : "unknown age"}`,
          input_message_content: {
            message_text: body.text,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
          ...(body.keyboard.length > 0
            ? { reply_markup: { inline_keyboard: body.keyboard } }
            : {}),
          ...(t.imageUrl ? { thumbnail_url: t.imageUrl } : {}),
        });
      }
    }

    if (results.length === 0 && this.cfg.siteUrl) {
      results.push({
        type: "article",
        id: "fallback",
        title: "Still crunching — open OGfinder",
        description: "Search is warming up; run it on the site or retry in a few seconds.",
        input_message_content: {
          message_text: `🔎 Find the original Solana token: ${this.cfg.siteUrl}/?q=${encodeURIComponent(q)}`,
        },
      });
    }

    await this.tg
      .answerInlineQuery(iq.id, results, 120)
      .catch((err) => console.warn("[bot] inline answer failed:", err));
  }

  // ── Send helpers ────────────────────────────────────────────────

  private async safeSend(
    chatId: number,
    replyTo: number | null,
    text: string,
    keyboard?: { text: string; url?: string; callback_data?: string }[][]
  ): Promise<TgMessage | null> {
    try {
      return await this.tg.sendMessage({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(replyTo != null
          ? {
              reply_parameters: {
                message_id: replyTo,
                allow_sending_without_reply: true,
              },
            }
          : {}),
        ...(keyboard && keyboard.length > 0
          ? { reply_markup: { inline_keyboard: keyboard } }
          : {}),
      });
    } catch (err) {
      if (err instanceof TelegramApiError && (err.code === 403 || err.code === 400)) {
        // Kicked / blocked / topic closed — nothing to do.
        return null;
      }
      console.warn("[bot] send failed:", err);
      return null;
    }
  }

  private async safeEdit(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: { text: string; url?: string; callback_data?: string }[][]
  ): Promise<void> {
    try {
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard && keyboard.length > 0
          ? { reply_markup: { inline_keyboard: keyboard } }
          : {}),
      });
    } catch (err) {
      console.warn("[bot] edit failed:", err);
    }
  }
}
