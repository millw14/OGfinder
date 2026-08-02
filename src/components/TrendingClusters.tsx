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

function ClusterCard({ cluster }: { cluster: TrendingCluster }) {
  const displayName = cluster.representativeName || cluster.skeleton;
  const watchQuery = cluster.representativeName.trim();
  const canWatch = watchQuery.length >= 2 && watchQuery.length <= 30;

  return (
    <section className="rounded-2xl border border-gray-800/60 bg-gray-900/40 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black tracking-tight text-gray-100">
            {displayName}
            {cluster.representativeSymbol && (
              <span className="ml-1.5 text-sm font-semibold text-gray-500">
                ${cluster.representativeSymbol}
              </span>
            )}
          </h2>
          <p
            className="mt-0.5 cursor-help text-[11px] text-gray-500"
            title={OLDEST_KNOWN_TOOLTIP}
          >
            oldest known{" "}
            <span className="text-gray-400">
              {formatDate(new Date(cluster.oldestKnownMs).toISOString())}
            </span>
            <span className="text-gray-700"> · </span>
            newest {timeAgo(new Date(cluster.newestSeenMs).toISOString())}
          </p>
          {cluster.marketCapUsd !== null && (
            <p className="mt-1.5 text-xs font-semibold text-emerald-400/90">
              MC {formatUsdVol(cluster.marketCapUsd)}
              {cluster.volumeUsd24h !== null && (
                <> · Vol {formatUsdVol(cluster.volumeUsd24h)}</>
              )}
              <span className="font-medium text-gray-600">
                {" "}
                across top {cluster.members.length}
              </span>
            </p>
          )}
        </div>
        <div className="flex-shrink-0 text-right">
          <span className="text-3xl font-black tabular-nums text-amber-400">
            {cluster.launches}
          </span>
          <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500/70">
            launches
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {cluster.members.map((m) => (
          <Link
            key={m.mint}
            href={`/?q=${encodeURIComponent(m.mint)}`}
            title={m.mint}
            className="rounded-full border border-gray-700/60 bg-gray-900/50 px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:border-amber-600/50 hover:bg-amber-950/20 hover:text-amber-300"
          >
            {m.name ?? truncateMint(m.mint)}
          </Link>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-800/60 pt-3">
        <Link
          href={`/?q=${encodeURIComponent(cluster.representativeName)}`}
          className="text-xs font-semibold text-amber-400/90 transition-colors hover:text-amber-300"
        >
          Run full OG search →
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
      <div className="mb-4 flex items-center gap-1">
        {WINDOWS.map((w) => (
          <button
            key={w.value}
            type="button"
            onClick={() => void selectWindow(w.value)}
            aria-pressed={activeWindow === w.value}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
              activeWindow === w.value
                ? "bg-amber-950/60 text-amber-300 ring-1 ring-amber-700/50"
                : "text-gray-500 hover:bg-gray-800/40 hover:text-gray-300"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="py-10 text-center text-sm text-red-400/80">{error}</p>
      ) : !current ? (
        <div className="flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-amber-500" />
        </div>
      ) : current.clusters.length === 0 ? (
        <div className="py-16 text-center">
          <div className="text-4xl opacity-90">📡</div>
          <p className="mt-4 text-base text-gray-400">
            No copycat clusters in this window yet
          </p>
          <p className="mt-1 text-sm text-gray-600">
            Clusters appear once the firehose sees a name launched 3+ times
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {current.clusters.map((c) => (
            <ClusterCard key={c.skeleton} cluster={c} />
          ))}
        </div>
      )}
    </div>
  );
}
