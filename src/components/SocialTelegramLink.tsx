"use client";

import { TELEGRAM_BOT_URL, TELEGRAM_BOT_USERNAME } from "@/lib/site-config";

/** Telegram paper-plane glyph (inline so no extra asset ships). */
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      aria-hidden
      className={className}
      fill="currentColor"
    >
      <path d="M21.9 4.4c.3-1.2-.4-1.7-1.2-1.4L2.9 9.9c-1.1.4-1.1 1-.2 1.3l4.5 1.4 10.4-6.6c.5-.3.9-.1.6.2l-8.4 7.6-.3 4.6c.4 0 .6-.2.9-.4l2.2-2.1 4.5 3.3c.8.5 1.4.2 1.6-.8l2.7-13z" />
    </svg>
  );
}

export function SocialTelegramLink() {
  return (
    <a
      href={TELEGRAM_BOT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-2 rounded-full border border-gray-700/60 bg-gray-900/40 px-3 py-1.5 text-gray-500 transition-colors hover:border-cyan-700/60 hover:bg-gray-800/50 hover:text-cyan-300"
      title={`OGfinder bot on Telegram — @${TELEGRAM_BOT_USERNAME}`}
    >
      <TelegramIcon className="shrink-0 opacity-90 group-hover:opacity-100" />
      <span className="text-[11px] font-medium">@{TELEGRAM_BOT_USERNAME}</span>
    </a>
  );
}

/** Hero variant: pitches the group auto-scan, not just the handle. */
export function TelegramHeroPill() {
  return (
    <a
      href={TELEGRAM_BOT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-4 inline-flex items-center gap-2 rounded-full border border-cyan-900/50 bg-cyan-950/20 px-4 py-1.5 text-xs font-medium text-cyan-300/90 transition-all hover:border-cyan-700/60 hover:bg-cyan-950/40 hover:text-cyan-200"
    >
      <TelegramIcon className="shrink-0" />
      <span>
        New: Telegram bot — auto-scans every CA in your group
      </span>
    </a>
  );
}
