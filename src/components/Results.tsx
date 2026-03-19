"use client";

import { TokenResult } from "@/lib/types";
import { TokenCard } from "./TokenCard";

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

interface ResultsProps {
  results: TokenResult[];
  isLoading: boolean;
  hasSearched: boolean;
  timing?: number;
}

export function Results({
  results,
  isLoading,
  hasSearched,
  timing,
}: ResultsProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className="py-20 text-center">
        <div className="text-4xl">🔍</div>
        <p className="mt-4 text-base text-gray-400">No tokens found</p>
        <p className="mt-1 text-sm text-gray-600">
          Try a different search term
        </p>
      </div>
    );
  }

  if (results.length === 0) return null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between px-1 text-xs text-gray-500">
        <span>
          {results.length} token{results.length !== 1 ? "s" : ""} found
          <span className="text-gray-700"> — sorted oldest first</span>
        </span>
        {timing != null && (
          <span className="tabular-nums text-gray-600">{timing}ms</span>
        )}
      </div>
      <div className="space-y-2.5">
        {results.map((token) => (
          <TokenCard key={token.mint} token={token} />
        ))}
      </div>
    </div>
  );
}
