/**
 * Public site configuration.
 *
 * TELEGRAM_BOT_USERNAME: the OGfinder Telegram bot's @username (no @).
 * Override at build time with NEXT_PUBLIC_TELEGRAM_BOT if the default
 * handle isn't the one registered with @BotFather.
 */
export const TELEGRAM_BOT_USERNAME =
  process.env.NEXT_PUBLIC_TELEGRAM_BOT?.trim().replace(/^@/, "") ||
  "OGfinderBot";

export const TELEGRAM_BOT_URL = `https://t.me/${TELEGRAM_BOT_USERNAME}`;
