"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { AlertsBell } from "@/components/AlertsBell";
import { TELEGRAM_GROUP_URL } from "@/lib/links";

/** Client-only: Lottie + canvas (same reason as the home hero). */
const OGLogo = dynamic(
  () => import("@/components/OGLogo").then((m) => ({ default: m.OGLogo })),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden
        className="inline-flex h-[30px] w-[58px] shrink-0 rounded-lg bg-surface-2/70"
      />
    ),
  }
);

const tabs = [
  { href: "/", label: "OGfinder", short: "OG" },
  { href: "/trending", label: "Trending", short: "Trend" },
  { href: "/wallet", label: "Wallet", short: "Wallet" },
] as const;

/** Sticky app header: wordmark · pill tabs · alerts · Telegram CTA. */
export function NavTabs() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-1.5 px-2.5 sm:gap-3 sm:px-4">
        <Link
          href="/"
          aria-label="OGfinder home"
          className="-ml-0.5 flex shrink-0 items-center rounded-xl px-0.5 py-1 transition-colors hover:bg-surface-1 sm:-ml-1 sm:px-1 [&_.og-logo-lottie]:cursor-pointer"
        >
          <OGLogo size={30} autoReplay={false} />
          <span className="-ml-px font-display text-[15px] font-bold leading-none tracking-tight text-fg sm:text-[19px]">
            finder
          </span>
        </Link>

        <nav
          aria-label="Primary"
          className="ml-auto flex items-center gap-0 sm:gap-1"
        >
          {tabs.map((tab) => {
            const active =
              tab.href === "/"
                ? pathname === "/"
                : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                aria-label={tab.label}
                className={`inline-flex h-11 items-center rounded-full px-2 text-meta font-medium transition-colors sm:h-9 sm:px-3.5 sm:text-sm ${
                  active
                    ? "bg-surface-2 text-og ring-1 ring-inset ring-line-str"
                    : "text-fg-3 hover:bg-surface-1 hover:text-fg-2"
                }`}
              >
                <span className="sm:hidden">{tab.short}</span>
                <span className="hidden sm:inline">{tab.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <AlertsBell />
          <a
            href={TELEGRAM_GROUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Add OGfinder to your Telegram group"
            aria-label="Add OGfinder to your Telegram group"
            className="inline-flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-og text-meta font-semibold text-bg transition-colors hover:bg-og-light sm:h-9 sm:w-auto sm:px-3.5 sm:text-[13px]"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="shrink-0"
            >
              <path d="m22 2-7 20-4-9-9-4 20-7Z" />
            </svg>
            <span className="hidden sm:inline">Add to Telegram</span>
          </a>
        </div>
      </div>
    </header>
  );
}
