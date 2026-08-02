import { createHash } from "crypto";

/**
 * Bot configuration from environment variables.
 *
 * Required:
 *   TELEGRAM_BOT_TOKEN   BotFather token — set it in Railway → Variables,
 *                        never in code or git.
 * Recommended:
 *   HELIUS_API_KEY       same key the website uses (DAS metadata + wallet)
 *   SITE_URL             public website origin for share links,
 *                        e.g. https://ogfinder.example (falls back to
 *                        NEXT_PUBLIC_SITE_URL)
 * Optional:
 *   PORT                     health/webhook HTTP port (Railway injects this)
 *   TELEGRAM_USE_WEBHOOK     "1" to receive updates via webhook instead of
 *                            long polling (needs a public domain)
 *   WEBHOOK_PUBLIC_URL       explicit https origin for the webhook (falls
 *                            back to RAILWAY_PUBLIC_DOMAIN)
 *   TELEGRAM_WEBHOOK_SECRET  webhook path/header secret (derived from the
 *                            token when unset)
 *   WATCH_INTERVAL_SEC       watchlist poll interval (default 300)
 *   WATCH_ALERT_PCT          price-move alert threshold in % (default 20)
 *   BOT_DB_PATH              sqlite path (default .data/bot.sqlite)
 *   BOT_ENABLE_URL_INDEXER   "1" to run the site's social-URL indexer in the
 *                            bot process too (off by default)
 */
export interface BotConfig {
  token: string;
  siteUrl: string | null;
  port: number;
  useWebhook: boolean;
  publicUrl: string | null;
  webhookSecret: string;
  watchIntervalSec: number;
  watchAlertPct: number;
  dbPath: string;
  enableUrlIndexer: boolean;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function readBool(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

function readNum(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): BotConfig | { error: string } {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return {
      error:
        "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather, then " +
        "add the token as a TELEGRAM_BOT_TOKEN variable (Railway → service → " +
        "Variables). Never commit it to the repo.",
    };
  }

  const rawSite =
    process.env.SITE_URL?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const siteUrl =
    rawSite && /^https?:\/\//.test(rawSite) ? stripTrailingSlash(rawSite) : null;

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const rawPublic =
    process.env.WEBHOOK_PUBLIC_URL?.trim() ||
    (railwayDomain ? `https://${railwayDomain}` : "");
  const publicUrl = rawPublic ? stripTrailingSlash(rawPublic) : null;

  const useWebhook = readBool(process.env.TELEGRAM_USE_WEBHOOK) && !!publicUrl;

  // Stable but unguessable without the token itself.
  const webhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ||
    createHash("sha256").update(`ogfinder:${token}`).digest("hex").slice(0, 32);

  return {
    token,
    siteUrl,
    port: readNum(process.env.PORT, 8080),
    useWebhook,
    publicUrl,
    webhookSecret,
    watchIntervalSec: readNum(process.env.WATCH_INTERVAL_SEC, 300),
    watchAlertPct: readNum(process.env.WATCH_ALERT_PCT, 20),
    dbPath: process.env.BOT_DB_PATH?.trim() || "",
    enableUrlIndexer: readBool(process.env.BOT_ENABLE_URL_INDEXER),
  };
}
