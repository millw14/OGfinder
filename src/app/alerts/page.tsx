"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NavTabs } from "@/components/NavTabs";
import { timeAgo, formatDate } from "@/lib/format";
import {
  StoredWatch,
  getStoredWatches,
  removeStoredWatch,
  setAlertsSeen,
} from "@/lib/watch-client";

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
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-amber-500" />
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
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_90%_60%_at_50%_-15%,rgba(251,191,36,0.09),transparent_55%)]"
        aria-hidden
      />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-2xl flex-1 px-4 pb-12 pt-4 sm:pt-8">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-gray-100 sm:text-4xl">
            Watches &amp; Alerts
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            New tokens launching with a name you watch show up here — stored in
            this browser only, no account needed
          </p>
        </div>

        {watches.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-4xl opacity-90">🔔</div>
            <p className="mt-4 text-base text-gray-400">No watches yet</p>
            <p className="mt-1 text-sm text-gray-600">
              Search a token name and hit{" "}
              <span className="text-amber-500/90">Watch for new clones</span>
            </p>
            <Link
              href="/"
              className="mt-5 inline-block rounded-full border border-gray-700/80 bg-gray-900/50 px-4 py-1.5 text-sm text-gray-400 transition-all hover:border-gray-600 hover:text-gray-200"
            >
              Go search
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {watches.map((w) => {
              const server = serverData.get(w.id);
              const alerts = server?.alerts ?? [];
              return (
                <section
                  key={w.id}
                  className="rounded-2xl border border-gray-800/60 bg-gray-900/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-800/60 px-4 py-3 sm:px-5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-gray-100">
                        {server?.displayQuery ?? w.query}
                      </p>
                      <p className="mt-0.5 text-[11px] text-gray-600">
                        {w.kind === "mint-cluster"
                          ? "Clone cluster watch"
                          : "Name watch"}
                        <span className="text-gray-700"> · </span>
                        since {formatDate(new Date(w.createdAt).toISOString())}
                        {!isLoading && !server && (
                          <>
                            <span className="text-gray-700"> · </span>
                            <span className="text-red-400/80">
                              no longer active on the server
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {server?.telegramLinked ? (
                        <span
                          title="Telegram alerts are linked for this watch"
                          className="rounded-md border border-cyan-800/60 bg-cyan-950/30 px-2 py-1 text-[11px] font-medium text-cyan-300/90"
                        >
                          TG ✓
                        </span>
                      ) : w.telegramLinkUrl ? (
                        <a
                          href={w.telegramLinkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Telegram to link clone alerts for this watch"
                          className="rounded-md border border-cyan-800/60 bg-gray-900/50 px-2.5 py-1 text-[11px] font-medium text-cyan-300/90 transition-colors hover:border-cyan-600/70 hover:bg-cyan-950/30"
                        >
                          Get Telegram alerts
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => deleteWatch(w)}
                        disabled={deletingId === w.id}
                        className="rounded-md border border-gray-700/60 bg-gray-900/50 px-2.5 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:border-red-800/60 hover:bg-red-950/30 hover:text-red-400 disabled:opacity-50"
                      >
                        {deletingId === w.id ? "Removing…" : "Delete watch"}
                      </button>
                    </div>
                  </div>

                  {alerts.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-gray-600 sm:px-5">
                      {isLoading
                        ? "Loading alerts…"
                        : "No clones spotted yet — alerts appear as the firehose sees new launches"}
                    </p>
                  ) : (
                    <ul className="divide-y divide-gray-800/40">
                      {alerts.map((a) => (
                        <li key={a.id}>
                          <Link
                            href={a.mint ? `/?q=${encodeURIComponent(a.mint)}` : "#"}
                            className="flex items-baseline justify-between gap-2 px-4 py-2.5 transition-colors hover:bg-gray-800/40 sm:px-5"
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold text-gray-200">
                                {a.name ?? "Unnamed token"}
                                {a.symbol && (
                                  <span className="ml-1 font-medium text-gray-500">
                                    ${a.symbol}
                                  </span>
                                )}
                              </span>
                              <span className="text-[10px] text-gray-600">
                                {a.source ? `via ${a.source}` : ""}
                                {a.mint && (
                                  <span className="ml-1 font-mono text-cyan-300/70">
                                    {a.mint.slice(0, 4)}…{a.mint.slice(-4)}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-600">
                              {timeAgo(new Date(a.matchedAt).toISOString())}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
