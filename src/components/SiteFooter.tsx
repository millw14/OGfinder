"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { DonationAddress } from "@/components/DonationAddress";
import { TELEGRAM_BOT_URL, TELEGRAM_GROUP_URL } from "@/lib/links";

/** Client-only: Lottie + canvas (same reason as the home hero). */
const SocialXLink = dynamic(
  () =>
    import("@/components/SocialXLink").then((m) => ({
      default: m.SocialXLink,
    })),
  { ssr: false }
);

const footerLink =
  "text-fg-3 transition-colors hover:text-fg-2 rounded-sm";

/** Shared across every page: pitch · links · donate + attribution. */
export function SiteFooter() {
  return (
    <footer className="relative mt-auto border-t border-line">
      <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-10 sm:grid-cols-3 sm:gap-6 sm:py-12">
        <div>
          <p className="font-display text-[15px] font-bold leading-none tracking-tight">
            <span className="text-og">OG</span>
            <span className="text-fg">finder</span>
          </p>
          <p className="mt-2 text-meta leading-relaxed text-fg-3">
            Find the original Solana token.
          </p>
        </div>

        <nav aria-label="Footer" className="text-meta">
          <ul className="space-y-2">
            <li>
              <a
                href={TELEGRAM_GROUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Add OGfinder to your Telegram group"
                className={footerLink}
              >
                Telegram bot — add to your group
              </a>
            </li>
            <li>
              <a
                href={TELEGRAM_BOT_URL}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the OGfinder Telegram bot"
                className={footerLink}
              >
                Open the bot
              </a>
            </li>
            <li>
              <Link href="/trending" className={footerLink}>
                Trending clusters
              </Link>
            </li>
            <li>
              <Link href="/wallet" className={footerLink}>
                Wallet scanner
              </Link>
            </li>
            <li className="pt-1">
              <SocialXLink />
            </li>
          </ul>
        </nav>

        <div className="sm:text-right">
          <div className="sm:flex sm:justify-end">
            <DonationAddress />
          </div>
          <p className="mt-3 text-micro leading-relaxed text-fg-4">
            powered by{" "}
            <a
              href="https://helius.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg-2"
            >
              Helius
            </a>
            {" · "}
            <a
              href="https://dexscreener.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg-2"
            >
              DexScreener
            </a>
            {" · "}
            <a
              href="https://jup.ag"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg-2"
            >
              Jupiter
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
