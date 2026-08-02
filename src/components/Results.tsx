"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { TokenResult, ScanSummary } from "@/lib/types";
import { bucketForToken, LAUNCHPAD_BUCKETS } from "@/lib/launchpads";
import {
  sortByCreationTime,
  sortByMarketCapLeaderboard,
  scoreConfidence,
  scoreMarketCapRank,
} from "@/lib/sort";
import { WatchButton } from "./WatchButton";

const TokenCard = dynamic(
  () =>
    import("./TokenCard").then((m) => ({ default: m.TokenCard })),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse rounded-2xl border border-gray-800/60 bg-gray-900/40 p-5">
        <div className="h-24 rounded-lg bg-gray-800/50" />
      </div>
    ),
  }
);

/** Client-only like TokenCard: pulls in Lottie (crown) via LottieHover. */
const ScanHero = dynamic(
  () =>
    import("./ScanHero").then((m) => ({ default: m.ScanHero })),
  {
    ssr: false,
    loading: () => (
      <div className="mb-4 animate-pulse rounded-2xl border border-gray-800/60 bg-gray-900/40 p-5">
        <div className="h-28 rounded-lg bg-gray-800/50" />
      </div>
    ),
  }
);

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-2xl border border-gray-800/60 bg-gray-900/40 p-5">
      <div className="flex gap-4">
        <div className="h-10 w-10 flex-shrink-0 rounded-xl bg-gray-800/80" />
        <div className="flex-1 space-y-3">
          <div className="flex gap-3">
            <div className="h-5 w-36 rounded-lg bg-gray-800/80" />
            <div className="h-5 w-14 rounded-lg bg-gray-800/80" />
          </div>
          <div className="h-4 w-52 rounded-lg bg-gray-800/60" />
          <div className="h-4 w-32 rounded-lg bg-gray-800/40" />
        </div>
      </div>
    </div>
  );
}

/** Copies a shareable /?q= link for the current search (plain text mode). */
function CopyLinkButton({ query }: { query: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?q=${encodeURIComponent(query)}`
      );
      setFailed(false);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setFailed(true);
      timerRef.current = setTimeout(() => setFailed(false), 1500);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy a shareable link to this search"
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        copied
          ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-400"
          : failed
            ? "border-red-700/60 bg-red-950/40 text-red-400"
            : "border-gray-700/60 bg-gray-900/50 text-gray-500 hover:border-gray-600 hover:text-gray-300"
      }`}
    >
      <span className="sr-only" role="status">
        {copied ? "Copied" : failed ? "Copy failed" : ""}
      </span>
      {copied ? "Copied" : failed ? "Copy failed" : "Copy link"}
    </button>
  );
}

interface ResultsProps {
  results: TokenResult[];
  lastQuery: string;
  searchMode?: "search" | "scan" | "social" | "compare" | null;
  isLoading: boolean;
  /** Fast-phase results shown — the full request is still verifying ages. */
  isEnriching?: boolean;
  hasSearched: boolean;
  timing?: number;
  error?: string | null;
  scan?: ScanSummary | null;
  /** Providers that failed during the request — results may be incomplete. */
  degraded?: string[] | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  dexscreener: "DexScreener",
  jupiter: "Jupiter",
  helius: "Helius",
  birdeye: "Birdeye",
  geckoterminal: "GeckoTerminal",
  "solana-rpc": "Solana RPC",
};

export function Results({
  results,
  lastQuery,
  searchMode = null,
  isLoading,
  isEnriching = false,
  hasSearched,
  timing,
  error,
  scan,
  degraded = null,
}: ResultsProps) {
  const [selectedBucketIds, setSelectedBucketIds] = useState<Set<string>>(
    () => new Set()
  );

  useEffect(() => {
    setSelectedBucketIds(new Set());
  }, [lastQuery]);

  const filtersActive = selectedBucketIds.size > 0;

  // Rank/confidence are computed ONCE from the full unfiltered result set so
  // every token keeps its global rank (and the OG crown stays on the globally
  // oldest token) no matter which launchpad filters are active.
  const ranked = useMemo(() => {
    if (searchMode === "social") {
      const sorted = sortByMarketCapLeaderboard([...results]);
      return scoreMarketCapRank(sorted);
    }
    const sorted = sortByCreationTime([...results]);
    return scoreConfidence(sorted, lastQuery);
  }, [results, lastQuery, searchMode]);

  const displayed = useMemo(() => {
    if (!filtersActive) return ranked;
    return ranked.filter((t) =>
      selectedBucketIds.has(bucketForToken(t.dexId, t.mint))
    );
  }, [ranked, filtersActive, selectedBucketIds]);

  // Per-bucket counts from the UNFILTERED ranked list, so chip counts stay
  // stable no matter which filters are active.
  const bucketCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of ranked) {
      const bucket = bucketForToken(t.dexId, t.mint);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return counts;
  }, [ranked]);

  const scannedVisible = useMemo(() => {
    if (scan?.mode !== "scan" || !scan.scannedMint) return false;
    return displayed.some((t) => t.mint === scan.scannedMint);
  }, [displayed, scan]);

  const hiddenByFilter = Boolean(
    scan?.mode === "scan" &&
      scan.scannedMint &&
      filtersActive &&
      !scannedVisible
  );

  function toggleBucket(id: string) {
    setSelectedBucketIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-900/40 bg-red-950/20 px-5 py-8 text-center">
        <p className="text-sm font-medium text-red-300">{error}</p>
        <p className="mt-2 text-xs text-red-400/80">
          Try a name, mint, or a social / website URL (8–512 characters).
        </p>
      </div>
    );
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl opacity-90">🔍</div>
        <p className="mt-4 text-base text-gray-400">No tokens found</p>
        <p className="mt-1 text-sm text-gray-600">
          {searchMode === "social"
            ? "No pairs on DexScreener list this URL in websites or socials yet"
            : "Try another name, mint, or social link"}
        </p>
      </div>
    );
  }

  if (results.length === 0) return null;

  const totalCount = results.length;
  const shownCount = displayed.length;

  return (
    <div>
      {scan && scan.mode === "scan" && scan.scannedMint && (
        <ScanHero
          scan={scan}
          ranked={ranked}
          totalCount={totalCount}
          hiddenByFilter={hiddenByFilter}
        />
      )}

      {searchMode === "social" && (
        <div className="mb-4 rounded-2xl border border-amber-900/35 bg-amber-950/15 px-4 py-3 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-500/90">
            Social link
          </p>
          <p className="mt-1 text-sm text-gray-400">
            Tokens whose DexScreener profile includes this URL, ranked by market
            cap, then 24h volume, then newer pairs.
          </p>
        </div>
      )}

      <div className="mb-3">
        <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-gray-600">
          Launchpad
        </p>
        <div className="flex flex-wrap gap-2">
          {LAUNCHPAD_BUCKETS.map(({ id, label }) => {
            const on = selectedBucketIds.has(id);
            const count = bucketCounts.get(id) ?? 0;
            const empty = count === 0;
            return (
              <button
                key={id}
                type="button"
                disabled={empty}
                aria-pressed={on}
                onClick={() => toggleBucket(id)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  empty
                    ? "cursor-default border-gray-800/60 bg-gray-900/30 text-gray-600 opacity-40"
                    : on
                      ? "border-amber-500/60 bg-amber-950/40 text-amber-200"
                      : "border-gray-700/80 bg-gray-900/50 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                {label}
                {!empty && (
                  <span
                    className={`ml-1 tabular-nums ${
                      on ? "text-amber-400/80" : "text-gray-600"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          {filtersActive && (
            <button
              type="button"
              onClick={() => setSelectedBucketIds(new Set())}
              className="rounded-full border border-transparent px-2 py-1 text-[11px] text-gray-500 underline-offset-2 hover:text-gray-300 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {degraded && degraded.length > 0 && (
        <div
          role="status"
          className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-400/90"
        >
          {degraded
            .map((p) => PROVIDER_LABELS[p] ?? p)
            .join(", ")}{" "}
          {degraded.length === 1 ? "was" : "were"} rate-limited or unavailable
          — results may be incomplete.
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        className="mb-3 flex items-center justify-between px-1 text-xs text-gray-500"
      >
        <span>
          {filtersActive ? (
            <>
              <span className="tabular-nums text-gray-300">{shownCount}</span>
              {shownCount !== 1 ? " tokens" : " token"} shown
              <span className="text-gray-700"> · </span>
              <span className="text-gray-600">{totalCount} total</span>
              <span className="text-gray-700">
                {" "}
                —{" "}
                {searchMode === "social"
                  ? "MC → vol → age"
                  : "oldest first"}
              </span>
            </>
          ) : (
            <>
              {totalCount} token{totalCount !== 1 ? "s" : ""} found
              <span className="text-gray-700">
                {" "}
                —{" "}
                {searchMode === "social" ? "MC → vol → age" : "oldest first"}
              </span>
            </>
          )}
        </span>
        <span className="flex items-center gap-2">
          {searchMode === "search" && lastQuery && (
            <>
              <WatchButton query={lastQuery} kind="name" />
              <CopyLinkButton query={lastQuery} />
            </>
          )}
          {isEnriching ? (
            <span className="animate-pulse font-medium text-amber-500/90">
              Verifying on-chain ages…
            </span>
          ) : (
            timing != null && (
              <span className="tabular-nums text-gray-600">{timing}ms</span>
            )
          )}
        </span>
      </div>

      {filtersActive && shownCount === 0 ? (
        <div className="rounded-2xl border border-gray-800/60 bg-gray-900/30 px-5 py-10 text-center">
          <p className="text-sm text-gray-400">No tokens match these filters</p>
          <p className="mt-1 text-xs text-gray-600">
            Clear launchpad filters or pick fewer options
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {displayed.map((token) => (
            <TokenCard key={token.mint} token={token} />
          ))}
        </div>
      )}
    </div>
  );
}
