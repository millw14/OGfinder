import { loadConfig, BotConfig } from "./config";
import { TelegramClient, TelegramApiError } from "./telegram";
import { BotStore } from "./store";
import { BotHandlers } from "./handlers";
import { startWatcher } from "./watcher";
import { startServer } from "./server";
import { TgUpdate, TgUser, TgBotCommand } from "./bot-types";

/**
 * OGfinder Telegram bot entrypoint.
 *
 * Modes:
 *  - long polling (default — zero config beyond TELEGRAM_BOT_TOKEN)
 *  - webhook (TELEGRAM_USE_WEBHOOK=1 + a public domain, e.g. Railway's)
 *
 * IMPORTANT: run exactly ONE instance in polling mode — Telegram rejects
 * concurrent getUpdates consumers (409).
 */

const ALLOWED_UPDATES = [
  "message",
  "channel_post",
  "callback_query",
  "inline_query",
  "my_chat_member",
];

const COMMANDS: TgBotCommand[] = [
  { command: "og", description: "Scan a CA (or name) — is it the OG?" },
  { command: "search", description: "Oldest tokens for a name, ranked" },
  { command: "compare", description: "Two CAs head-to-head by age" },
  { command: "wallet", description: "Quick wallet PnL & side wallets" },
  { command: "trending", description: "Boosted Solana tokens right now" },
  { command: "watch", description: "Price & rug alerts for a CA" },
  { command: "watchlist", description: "What this chat watches" },
  { command: "unwatch", description: "Stop watching a CA" },
  { command: "settings", description: "Group auto-scan & quiet mode" },
  { command: "stats", description: "This chat's scan stats" },
  { command: "help", description: "How the bot works" },
];

const MAX_CONCURRENT_UPDATES = 8;
const MAX_QUEUED_UPDATES = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if ("error" in cfg) {
    console.error(`\n[bot] ✗ ${cfg.error}\n`);
    process.exit(1);
  }

  const startedAt = Date.now();
  const store = new BotStore(cfg.dbPath);
  const tg = new TelegramClient(cfg.token);

  let me: TgUser | null = null;
  for (let attempt = 1; attempt <= 5 && !me; attempt++) {
    try {
      me = await tg.getMe();
    } catch (err) {
      const detail =
        err instanceof TelegramApiError && err.code === 401
          ? "Telegram rejected the token (401) — re-check TELEGRAM_BOT_TOKEN"
          : `cannot reach api.telegram.org (${(err as Error).message})`;
      console.error(`[bot] getMe attempt ${attempt}/5 failed: ${detail}`);
      if (err instanceof TelegramApiError && err.code === 401) process.exit(1);
      await sleep(3000 * attempt);
    }
  }
  if (!me) {
    console.error("[bot] ✗ could not reach Telegram — check network/egress.");
    process.exit(1);
  }

  const botUsername = me.username ?? "unknown_bot";
  console.log(`[bot] @${botUsername} (id ${me.id}) is booting…`);
  if (!cfg.siteUrl) {
    console.warn(
      "[bot] SITE_URL not set — verdict cards will omit the website button."
    );
  }
  if (!process.env.HELIUS_API_KEY?.trim()) {
    console.warn(
      "[bot] HELIUS_API_KEY not set — creation dates fall back to public RPC and /wallet is disabled."
    );
  }

  const handlers = new BotHandlers(tg, store, cfg, botUsername, me.id);

  await tg
    .setMyCommands(COMMANDS)
    .catch((err) => console.warn("[bot] setMyCommands failed:", err));

  if (cfg.enableUrlIndexer) {
    const { ensurePollerStarted } = await import("../lib/poller");
    ensurePollerStarted();
    console.log("[bot] social-URL indexer enabled");
  }

  // ── Update pump: bounded concurrency, bounded queue ─────────────
  let active = 0;
  const pending: TgUpdate[] = [];
  const pump = () => {
    while (active < MAX_CONCURRENT_UPDATES && pending.length > 0) {
      const update = pending.shift()!;
      active++;
      handlers
        .handleUpdate(update)
        .catch((err) => console.error("[bot] handler crashed:", err))
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  const enqueue = (u: TgUpdate) => {
    pending.push(u);
    if (pending.length > MAX_QUEUED_UPDATES) {
      pending.splice(0, pending.length - MAX_QUEUED_UPDATES);
    }
    pump();
  };

  let mode: "polling" | "webhook" | "starting" = "starting";
  const server = startServer({
    cfg,
    enqueue,
    status: () => ({
      ok: true,
      mode,
      botUsername,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }),
  });

  let stopping = false;

  if (cfg.useWebhook && cfg.publicUrl) {
    const url = `${cfg.publicUrl}/webhook/${cfg.webhookSecret}`;
    await tg.setWebhook(url, cfg.webhookSecret, ALLOWED_UPDATES);
    mode = "webhook";
    console.log(`[bot] webhook mode → ${cfg.publicUrl}/webhook/***`);
  } else {
    await tg.deleteWebhook().catch(() => undefined);
    mode = "polling";
    console.log("[bot] long-polling mode");
    void (async () => {
      let offset: number | undefined;
      let errStreak = 0;
      while (!stopping) {
        try {
          const updates = await tg.getUpdates(offset, ALLOWED_UPDATES);
          errStreak = 0;
          for (const u of updates) {
            offset = u.update_id + 1;
            enqueue(u);
          }
        } catch (err) {
          if (stopping) break;
          if (err instanceof TelegramApiError && err.code === 409) {
            console.warn(
              "[bot] another getUpdates consumer is running (409) — retrying in 10s. Keep replicas at 1."
            );
            await sleep(10_000);
          } else {
            errStreak++;
            const backoff = Math.min(1000 * 2 ** errStreak, 30_000);
            console.warn(
              `[bot] poll error (retry in ${backoff}ms):`,
              err instanceof Error ? err.message : err
            );
            await sleep(backoff);
          }
        }
      }
    })();
  }

  const stopWatcher = startWatcher(tg, store, cfg);
  console.log(
    `[bot] ready — watchlist every ${cfg.watchIntervalSec}s, alert threshold ±${cfg.watchAlertPct}%`
  );

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[bot] ${signal} — shutting down…`);
    stopWatcher();
    server.close();
    // Give in-flight handlers a moment, then exit.
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
