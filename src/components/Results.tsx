"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { TokenResult, ScanSummary, SearchHistory } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { bucketForToken, LAUNCHPAD_BUCKETS } from "@/lib/launchpads";
import {
  sortByCreationTime,
  sortByMarketCapLeaderboard,
  scoreConfidence,
  scoreMarketCapRank,
} from "@/lib/sort";
import { WatchButton } from "./WatchButton";

/** Sweep used by every skeleton; parked by the reduced-motion block. */
function Shimmer() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/[0.045] to-transparent"
    />
  );
}

/** ~96px tall and rounded-2xl — dimension-matched to a result card. */
function SkeletonCard() {
  return (
    <div className="relative h-24 overflow-hidden rounded-2xl border bg-surface-1 p-4">
      <div className="flex h-full items-center gap-3">
        <div className="h-10 w-10 shrink-0 rounded-xl bg-surface-2" />
        <div className="flex-1 space-y-2.5">
          <div className="flex gap-2">
            <div className="h-4 w-32 rounded-md bg-surface-2" />
            <div className="h-4 w-12 rounded-md bg-surface-3" />
          </div>
          <div className="h-3 w-48 rounded-md bg-surface-2/80" />
          <div className="h-3 w-28 rounded-md bg-surface-2/60" />
        </div>
      </div>
      <Shimmer />
    </div>
  );
}

/** Taller stand-in for the verdict hero while its chunk loads. */
function SkeletonHero() {
  return (
    <div className="relative mb-4 h-36 overflow-hidden rounded-2xl border bg-surface-1 p-5">
      <div className="space-y-3">
        <div className="h-3 w-24 rounded-md bg-surface-3" />
        <div className="h-7 w-56 rounded-lg bg-surface-2" />
        <div className="h-4 w-40 rounded-md bg-surface-2/80" />
        <div className="h-4 w-64 rounded-md bg-surface-2/60" />
      </div>
      <Shimmer />
    </div>
  );
}

const TokenCard = dynamic(
  () =>
    import("./TokenCard").then((m) => ({ default: m.TokenCard })),
  {
    ssr: false,
    loading: () => <SkeletonCard />,
  }
);

/** Client-only like TokenCard: pulls in Lottie (crown) via LottieHover. */
const ScanHero = dynamic(
  () =>
    import("./ScanHero").then((m) => ({ default: m.ScanHero })),
  {
    ssr: false,
    loading: () => <SkeletonHero />,
  }
);

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
      className={`rounded-full border px-2.5 py-1 text-micro font-medium transition-colors ${
        copied
          ? "border-up/40 bg-up/10 text-up"
          : failed
            ? "border-down/40 bg-down/10 text-down"
            : "bg-surface-2 text-fg-3 hover:border-line-str hover:text-fg-2"
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
  /** Text mode: leaderboard snapshot history + OG-flip verdict. */
  history?: SearchHistory | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  dexscreener: "DexScreener",
  jupiter: "Jupiter",
  helius: "Helius",
  birdeye: "Birdeye",
  geckoterminal: "GeckoTerminal",
  "solana-rpc": "Solana RPC",
};

/** Entrance stagger: capped so a long list never crawls in. */
const STAGGER_MS = 45;
const MAX_STAGGERED = 8;

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
  history = null,
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
      <div className="space-y-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-down/30 border-l-2 border-l-down/70 bg-down/[0.06] px-5 py-8 text-center">
        <p className="font-display text-[15px] font-medium tracking-tight text-down">
          {error}
        </p>
        <p className="mt-2 text-meta text-fg-3">
          Try a name, mint, or a social / website URL (8–512 characters).
        </p>
      </div>
    );
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className="rounded-2xl border bg-surface-1/60 px-5 py-14 text-center">
        <span
          aria-hidden
          className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border bg-surface-2 text-fg-3"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </span>
        <p className="mt-4 font-display text-[15px] font-medium tracking-tight text-fg-2">
          No tokens found
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-meta leading-relaxed text-fg-3">
          {searchMode === "social"
            ? "No pairs on DexScreener list this URL in websites or socials yet"
            : "Try another name, mint, or social link — or paste the contract address straight from the chart"}
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
        <div className="mb-4 rounded-2xl border bg-surface-1 px-4 py-3 sm:px-5">
          <p className="text-micro font-semibold uppercase tracking-[0.14em] text-scan">
            Social link
          </p>
          <p className="mt-1 text-sm leading-relaxed text-fg-2">
            Tokens whose DexScreener profile includes this URL, ranked by market
            cap, then 24h volume, then newer pairs.
          </p>
        </div>
      )}

      <div className="mb-3">
        <p className="mb-2 px-1 text-micro font-medium uppercase tracking-[0.14em] text-fg-4">
          Launchpad
        </p>
        <div className="flex flex-wrap gap-1.5">
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
                className={`rounded-full border px-2.5 py-1 text-micro font-medium transition-colors ${
                  empty
                    ? "cursor-default bg-surface-1 text-fg-4 opacity-40"
                    : on
                      ? "border-og/30 bg-og/10 text-og"
                      : "bg-surface-2 text-fg-3 hover:border-line-str hover:text-fg-2"
                }`}
              >
                {label}
                {!empty && (
                  <span
                    className={`ml-1.5 font-mono ${
                      on ? "text-og/70" : "text-fg-4"
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
              className="rounded-full border border-transparent px-2 py-1 text-micro text-fg-3 underline-offset-2 transition-colors hover:text-og hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {degraded && degraded.length > 0 && (
        <div
          role="status"
          className="mb-3 rounded-xl border border-warn/25 border-l-2 border-l-warn/70 bg-warn/[0.06] px-3 py-2 text-meta leading-relaxed text-warn"
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
        className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 text-meta text-fg-3"
      >
        <span>
          {filtersActive ? (
            <>
              <span className="font-mono text-fg">{shownCount}</span>
              {shownCount !== 1 ? " tokens" : " token"} shown
              <span className="text-fg-4"> · </span>
              <span className="font-mono text-fg-4">{totalCount}</span>
              <span className="text-fg-4"> total</span>
              <span className="text-fg-4">
                {" "}
                —{" "}
                {searchMode === "social"
                  ? "MC → vol → age"
                  : "oldest first"}
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-fg">{totalCount}</span> token
              {totalCount !== 1 ? "s" : ""} found
              <span className="text-fg-4">
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
            <span className="animate-pulse font-medium text-og">
              Verifying on-chain ages…
            </span>
          ) : (
            timing != null && (
              <span className="font-mono text-fg-4">{timing}ms</span>
            )
          )}
        </span>
      </div>

      {searchMode === "search" && history && (
        history.flip?.flipped ? (
          <div className="mb-3 rounded-xl border border-og/30 border-l-2 border-l-og bg-og/[0.07] px-3 py-2 text-meta leading-relaxed text-og-light">
            <span aria-hidden>⚡</span> Copycat flipped the OG on{" "}
            {formatDate(new Date(history.flip.at).toISOString())} —{" "}
            <span className="font-semibold">{history.flip.challenger.name}</span>{" "}
            overtook by{" "}
            {history.flip.metric === "marketcap" ? "market cap" : "liquidity"}
          </div>
        ) : history.snapshotCount >= 2 ? (
          <p className="mb-3 px-1 text-micro text-fg-4">
            Tracking since{" "}
            {formatDate(new Date(history.firstSnapshotAt).toISOString())}
            <span className="text-fg-4"> · </span>
            <span className="font-mono">{history.snapshotCount}</span> snapshots
            <span className="text-fg-4"> · </span>
            OG still leads
          </p>
        ) : null
      )}

      {filtersActive && shownCount === 0 ? (
        <div className="rounded-2xl border bg-surface-1/60 px-5 py-10 text-center">
          <p className="text-sm text-fg-2">No tokens match these filters</p>
          <p className="mt-1 text-meta text-fg-3">
            Clear launchpad filters or pick fewer options
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {displayed.map((token, i) => (
            <div
              key={token.mint}
              className="animate-rise"
              style={{
                animationDelay: `${Math.min(i, MAX_STAGGERED) * STAGGER_MS}ms`,
              }}
            >
              <TokenCard token={token} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
