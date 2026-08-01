"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { TokenResult, ScanSummary } from "@/lib/types";
import { bucketForDexId, LAUNCHPAD_BUCKETS } from "@/lib/launchpads";
import {
  sortByCreationTime,
  sortByMarketCapLeaderboard,
  scoreConfidence,
  scoreMarketCapRank,
} from "@/lib/sort";

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

function ScanBanner({
  scan,
  hiddenByFilter,
  effectiveRank,
  effectiveIsOG,
}: {
  scan: ScanSummary;
  hiddenByFilter: boolean;
  effectiveRank: number | null;
  effectiveIsOG: boolean;
}) {
  if (scan.mode !== "scan" || !scan.scannedMint) return null;

  const name =
    scan.scanName && scan.scanSymbol
      ? `${scan.scanName} ($${scan.scanSymbol})`
      : scan.scanName ?? scan.scanSymbol ?? "Token";

  return (
    <div className="mb-4 rounded-2xl border border-cyan-900/40 bg-gradient-to-br from-cyan-950/30 to-gray-900/50 p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-500/90">
        Contract scan
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-300 sm:text-base">
        Resolved <span className="font-medium text-gray-100">{name}</span>
        {hiddenByFilter ? (
          <span className="text-gray-500">
            {" "}
            — your mint doesn’t match the selected launchpad filters. Clear
            filters to see it in the full list.
          </span>
        ) : effectiveRank != null ? (
          <>
            {" "}
            — your mint is{" "}
            <span className="font-semibold text-cyan-200">
              #{effectiveRank} oldest
            </span>
            {effectiveIsOG ? (
              <span className="text-yellow-400"> — this is the OG.</span>
            ) : (
              <span className="text-gray-500">
                {" "}
                (#1 in the list is the oldest match we found).
              </span>
            )}
          </>
        ) : (
          <span className="text-gray-500">
            {" "}
            — this mint didn’t appear in the ranked results (try searching by
            name).
          </span>
        )}
      </p>
    </div>
  );
}

interface ResultsProps {
  results: TokenResult[];
  lastQuery: string;
  searchMode?: "search" | "scan" | "social" | null;
  isLoading: boolean;
  hasSearched: boolean;
  timing?: number;
  error?: string | null;
  scan?: ScanSummary | null;
}

export function Results({
  results,
  lastQuery,
  searchMode = null,
  isLoading,
  hasSearched,
  timing,
  error,
  scan,
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
      selectedBucketIds.has(bucketForDexId(t.dexId))
    );
  }, [ranked, filtersActive, selectedBucketIds]);

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

  // The server's scan verdict is authoritative — never recomputed client-side.
  const effectiveRank = scan?.scannedRank ?? null;
  const effectiveIsOG = scan?.isScannedOG === true;

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
      {scan && (
        <ScanBanner
          scan={scan}
          hiddenByFilter={hiddenByFilter}
          effectiveRank={hiddenByFilter ? null : effectiveRank}
          effectiveIsOG={hiddenByFilter ? false : effectiveIsOG}
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
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleBucket(id)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? "border-amber-500/60 bg-amber-950/40 text-amber-200"
                    : "border-gray-700/80 bg-gray-900/50 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                {label}
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

      <div className="mb-3 flex items-center justify-between px-1 text-xs text-gray-500">
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
        {timing != null && (
          <span className="tabular-nums text-gray-600">{timing}ms</span>
        )}
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
