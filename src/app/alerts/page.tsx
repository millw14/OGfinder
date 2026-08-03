"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NavTabs } from "@/components/NavTabs";
import { SiteFooter } from "@/components/SiteFooter";
import { Chip } from "@/components/Badge";
import { timeAgo, formatDate } from "@/lib/format";
import { TELEGRAM_GROUP_URL } from "@/lib/links";
import {
  StoredWatch,
  getStoredWatches,
  removeStoredWatch,
  setAlertsSeen,
} from "@/lib/watch-client";

const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

/** Row glyph: a gold bolt for OG flips, a neutral spark for new clones. */
function AlertGlyph({ isFlip }: { isFlip: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
        isFlip ? "border-og/30 bg-og/10 text-og" : "bg-surface-2 text-fg-3"
      }`}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isFlip ? (
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v8M8 12h8" />
          </>
        )}
      </svg>
    </span>
  );
}

interface AlertItem {
  id: number;
  kind: string;
  mint: string | null;
  name: string | null;
  symbol: string | null;
  source: string | null;
  matchedAt: number;
}

interface WatchAlerts {
  id: number;
  displayQuery: string;
  kind: string;
  telegramLinked: boolean;
  alerts: AlertItem[];
}

/** Suspense wrapper matches /wallet — keeps the page shell consistent. */
export default function AlertsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-str border-t-og" />
        </div>
      }
    >
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const [watches, setWatches] = useState<StoredWatch[]>([]);
  const [serverData, setServerData] = useState<Map<number, WatchAlerts>>(
    () => new Map()
  );
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchAlerts = useCallback(async (stored: StoredWatch[]) => {
    if (stored.length === 0) {
      setServerData(new Map());
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const param = stored
        .slice(0, 10)
        .map((w) => `${w.id}:${w.secret}`)
        .join(",");
      const res = await fetch(
        `/api/alerts?watches=${encodeURIComponent(param)}`
      );
      if (res.ok) {
        const data = (await res.json()) as { watches?: WatchAlerts[] };
        setServerData(new Map((data.watches ?? []).map((w) => [w.id, w])));
      }
    } catch {
      /* alert feed is best-effort */
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = getStoredWatches();
    setWatches(stored);
    setAlertsSeen(Date.now());
    void fetchAlerts(stored);
  }, [fetchAlerts]);

  const deleteWatch = useCallback(
    async (watch: StoredWatch) => {
      setDeletingId(watch.id);
      try {
        // A 404 (already gone server-side) still clears local state.
        await fetch(
          `/api/watch?id=${watch.id}&secret=${encodeURIComponent(watch.secret)}`,
          { method: "DELETE" }
        );
      } catch {
        /* network error — still forget locally */
      } finally {
        removeStoredWatch(watch.id);
        setWatches(getStoredWatches());
        setDeletingId(null);
      }
    },
    []
  );

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="page-ambient pointer-events-none fixed inset-0" aria-hidden />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8 sm:pt-12">
        <div className="mb-8 text-center">
          <p className={`${EYEBROW} text-og`}>Standing watch</p>
          <h1 className="mt-2 font-display text-[34px] font-bold leading-[1.05] tracking-tight text-fg sm:text-[40px]">
            Watches &amp; Alerts
          </h1>
          <p className="mx-auto mt-3 max-w-md text-balance text-sm leading-relaxed text-fg-2">
            New tokens launching with a name you watch show up here — stored in
            this browser only, no account needed.
          </p>
        </div>

        {watches.length === 0 ? (
          <div className="rounded-2xl border bg-surface-1/60 px-5 py-12 text-center">
            <span
              aria-hidden
              className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border bg-surface-2 text-fg-3"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </span>
            <p className="mt-4 font-display text-[15px] font-medium tracking-tight text-fg-2">
              No watches yet
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-meta leading-relaxed text-fg-3">
              Search a token name or scan a contract, then hit{" "}
              <span className="font-medium text-og">Watch for new clones</span>{" "}
              on the verdict. Every new launch that folds to the same name lands
              here.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/"
                className="inline-flex items-center rounded-xl border border-og/30 px-3.5 py-2 text-meta font-semibold text-og/90 transition-colors hover:border-og/50 hover:bg-og/10 hover:text-og"
              >
                Go search
              </Link>
              <a
                href={TELEGRAM_GROUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border bg-surface-2 px-3.5 py-2 text-meta font-semibold text-fg-2 transition-colors hover:border-line-str hover:text-fg"
              >
                <svg
                  aria-hidden
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                >
                  <path d="m22 2-7 20-4-9-9-4 20-7Z" />
                </svg>
                Get alerts in Telegram
              </a>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {watches.map((w) => {
              const server = serverData.get(w.id);
              const alerts = server?.alerts ?? [];
              return (
                <section
                  key={w.id}
                  className="overflow-hidden rounded-2xl border bg-surface-1"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-[15px] font-bold tracking-tight text-fg">
                        {server?.displayQuery ?? w.query}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Chip tone="neutral">
                          {w.kind === "mint-cluster"
                            ? "Clone cluster watch"
                            : "Name watch"}
                        </Chip>
                        <span className="text-micro text-fg-4">
                          since{" "}
                          <span className="font-mono text-fg-3">
                            {formatDate(new Date(w.createdAt).toISOString())}
                          </span>
                        </span>
                        {!isLoading && !server && (
                          <Chip
                            tone="down"
                            title="This watch expired or was removed server-side — delete it to tidy up"
                          >
                            no longer active on the server
                          </Chip>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {server?.telegramLinked ? (
                        <Chip
                          tone="scan"
                          size="md"
                          title="Telegram alerts are linked for this watch"
                        >
                          TG ✓
                        </Chip>
                      ) : w.telegramLinkUrl ? (
                        <a
                          href={w.telegramLinkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Telegram to link clone alerts for this watch"
                          className="inline-flex items-center rounded-full border border-scan/25 bg-scan/10 px-2.5 py-1 text-micro font-medium text-scan transition-colors hover:border-scan/45 hover:bg-scan/[0.16]"
                        >
                          Get Telegram alerts
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => deleteWatch(w)}
                        disabled={deletingId === w.id}
                        className="inline-flex items-center rounded-full border bg-surface-2 px-2.5 py-1 text-micro font-medium text-fg-3 transition-colors hover:border-risk/40 hover:bg-risk/10 hover:text-risk disabled:opacity-50"
                      >
                        {deletingId === w.id ? "Removing…" : "Delete watch"}
                      </button>
                    </div>
                  </div>

                  {alerts.length === 0 ? (
                    <p className="border-t bg-bg/50 px-4 py-4 text-meta text-fg-3 sm:px-5">
                      {isLoading
                        ? "Loading alerts…"
                        : "No clones spotted yet — alerts appear as the firehose sees new launches"}
                    </p>
                  ) : (
                    <ul className="divide-y border-t">
                      {alerts.map((a) => {
                        const query = server?.displayQuery ?? w.query;
                        const isFlip = a.kind === "flip";
                        const href = isFlip
                          ? `/?q=${encodeURIComponent(query)}`
                          : a.mint
                            ? `/?q=${encodeURIComponent(a.mint)}`
                            : "#";
                        return (
                          <li key={a.id}>
                            <Link
                              href={href}
                              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2 sm:px-5"
                            >
                              <AlertGlyph isFlip={isFlip} />
                              <span className="min-w-0 flex-1">
                                {isFlip ? (
                                  <>
                                    <span className="block truncate text-meta font-semibold text-og">
                                      {query}: copycat flipped the OG
                                    </span>
                                    {a.name && (
                                      <span className="text-micro text-fg-4">
                                        {a.name} now leads
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <span className="block truncate text-meta font-semibold text-fg">
                                      {a.name ?? "Unnamed token"}
                                      {a.symbol && (
                                        <span className="ml-1 font-mono text-micro font-normal text-fg-3">
                                          ${a.symbol}
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-fg-4">
                                      {a.source ? `via ${a.source}` : ""}
                                      {a.mint && (
                                        <span className="rounded-full border border-scan/25 bg-scan/10 px-1.5 py-px font-mono text-scan">
                                          {a.mint.slice(0, 4)}…{a.mint.slice(-4)}
                                        </span>
                                      )}
                                    </span>
                                  </>
                                )}
                              </span>
                              <span className="mt-0.5 flex-shrink-0 font-mono text-micro text-fg-4">
                                {timeAgo(new Date(a.matchedAt).toISOString())}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
