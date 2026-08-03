"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  TrendingCluster,
  TrendingResult,
  TrendingWindow,
} from "@/lib/trending";
import { formatDate, timeAgo } from "@/lib/format";
import { WatchButton } from "./WatchButton";

const WINDOWS: { value: TrendingWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const OLDEST_KNOWN_TOOLTIP =
  "Bounded by OGfinder's 14-day discovery window — run the full OG search for the real verdict";

function formatUsdVol(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function truncateMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

function ClusterCard({ cluster }: { cluster: TrendingCluster }) {
  const displayName = cluster.representativeName || cluster.skeleton;
  const watchQuery = cluster.representativeName.trim();
  const canWatch = watchQuery.length >= 2 && watchQuery.length <= 30;

  return (
    <section className="overflow-hidden rounded-2xl border bg-surface-1 transition-colors hover:border-line-str">
      {/* ── Identity + the focal launch count ───────────────────────────── */}
      <div className="flex items-start justify-between gap-4 p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold tracking-tight text-fg sm:text-xl">
            {displayName}
            {cluster.representativeSymbol && (
              <span className="ml-1.5 font-mono text-meta font-normal text-fg-3">
                ${cluster.representativeSymbol}
              </span>
            )}
          </h2>
          <p
            className="mt-1 cursor-help text-micro text-fg-4"
            title={OLDEST_KNOWN_TOOLTIP}
          >
            oldest known{" "}
            <span className="font-mono text-fg-3">
              {formatDate(new Date(cluster.oldestKnownMs).toISOString())}
            </span>
            <span className="text-fg-4"> · </span>
            newest{" "}
            <span className="font-mono text-fg-3">
              {timeAgo(new Date(cluster.newestSeenMs).toISOString())}
            </span>
          </p>
          {cluster.marketCapUsd !== null && (
            <p className="mt-2 text-meta font-semibold text-up">
              MC <span className="font-mono">{formatUsdVol(cluster.marketCapUsd)}</span>
              {cluster.volumeUsd24h !== null && (
                <>
                  <span className="text-fg-4"> · </span>Vol{" "}
                  <span className="font-mono">
                    {formatUsdVol(cluster.volumeUsd24h)}
                  </span>
                </>
              )}
              <span className="font-normal text-fg-4">
                {" "}
                across top {cluster.members.length}
              </span>
            </p>
          )}
        </div>
        <div className="flex-shrink-0 text-right">
          <span className="block font-mono text-[32px] font-medium leading-none tabular-nums text-og sm:text-[38px]">
            {cluster.launches}
          </span>
          <span className={`${EYEBROW} mt-1.5 block text-og/60`}>launches</span>
        </div>
      </div>

      {/* ── Members ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 border-t bg-bg/50 px-4 py-3 sm:px-5">
        {cluster.members.map((m) => (
          <Link
            key={m.mint}
            href={`/?q=${encodeURIComponent(m.mint)}`}
            title={m.mint}
            className={`max-w-[14rem] truncate rounded-full border bg-surface-2 px-2.5 py-1 text-micro text-fg-2 transition-colors hover:border-og/40 hover:bg-og/10 hover:text-og ${
              m.name ? "" : "font-mono"
            }`}
          >
            {m.name ?? truncateMint(m.mint)}
          </Link>
        ))}
      </div>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 sm:px-5">
        <Link
          href={`/?q=${encodeURIComponent(cluster.representativeName)}`}
          className="inline-flex items-center gap-1 text-meta font-semibold text-fg-2 transition-colors hover:text-og"
        >
          Run full OG search
          <span aria-hidden>→</span>
        </Link>
        {canWatch && <WatchButton query={watchQuery} kind="name" />}
      </div>
    </section>
  );
}

/**
 * Client island: 24h/7d toggle over the server-rendered initial result.
 * The other window is fetched from /api/trending on first toggle and kept
 * in state (the API caches 60s server-side anyway).
 */
export function TrendingClusters({ initial }: { initial: TrendingResult }) {
  const [activeWindow, setActiveWindow] = useState<TrendingWindow>(
    initial.window
  );
  const [results, setResults] = useState<
    Partial<Record<TrendingWindow, TrendingResult>>
  >({ [initial.window]: initial });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectWindow = async (w: TrendingWindow) => {
    setActiveWindow(w);
    setError(null);
    if (results[w] || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/trending?window=${w}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as TrendingResult;
      setResults((prev) => ({ ...prev, [w]: data }));
    } catch {
      setError("Couldn’t load clusters — try again shortly");
    } finally {
      setLoading(false);
    }
  };

  const current = results[activeWindow];

  return (
    <div>
      {/* Segmented control: one recessed track, gold pill on the active window. */}
      <div className="mb-5 flex justify-center">
        <div
          role="group"
          aria-label="Time window"
          className="inline-flex items-center gap-1 rounded-full border bg-surface-2 p-1"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => void selectWindow(w.value)}
              aria-pressed={activeWindow === w.value}
              className={`rounded-full px-4 py-1.5 text-meta font-semibold transition-colors ${
                activeWindow === w.value
                  ? "bg-og/[0.14] text-og ring-1 ring-inset ring-og/35"
                  : "text-fg-3 hover:bg-surface-3 hover:text-fg-2"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-down/30 border-l-2 border-l-down/70 bg-down/[0.06] px-5 py-8 text-center">
          <p className="font-display text-[15px] font-medium tracking-tight text-down">
            {error}
          </p>
        </div>
      ) : !current ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-str border-t-og" />
        </div>
      ) : current.clusters.length === 0 ? (
        <div className="rounded-2xl border bg-surface-1/60 px-5 py-14 text-center">
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
              <path d="M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 16.24a6 6 0 0 1 0-8.48M16.24 7.76a6 6 0 0 1 0 8.48" />
              <circle cx="12" cy="12" r="2" />
            </svg>
          </span>
          <p className="mt-4 font-display text-[15px] font-medium tracking-tight text-fg-2">
            No copycat clusters in this window yet
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-meta leading-relaxed text-fg-3">
            Clusters appear once the firehose sees a name launched 3+ times
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {current.clusters.map((c, i) => (
            <div
              key={c.skeleton}
              className="animate-rise"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <ClusterCard cluster={c} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
