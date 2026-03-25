"use client";

import dynamic from "next/dynamic";
import { TokenResult } from "@/lib/types";

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

export interface ScanSummary {
  mode?: "search" | "scan";
  isScannedOG?: boolean;
  scannedRank?: number | null;
  scanName?: string | null;
  scanSymbol?: string | null;
  scannedMint?: string;
}

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

function ScanBanner({ scan }: { scan: ScanSummary }) {
  if (scan.mode !== "scan" || !scan.scannedMint) return null;

  const name =
    scan.scanName && scan.scanSymbol
      ? `${scan.scanName} ($${scan.scanSymbol})`
      : scan.scanName ?? scan.scanSymbol ?? "Token";

  const rank = scan.scannedRank;
  const isOG = scan.isScannedOG === true;

  return (
    <div className="mb-4 rounded-2xl border border-cyan-900/40 bg-gradient-to-br from-cyan-950/30 to-gray-900/50 p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-500/90">
        Contract scan
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-300 sm:text-base">
        Resolved <span className="font-medium text-gray-100">{name}</span>
        {rank != null ? (
          <>
            {" "}
            — your mint is{" "}
            <span className="font-semibold text-cyan-200">
              #{rank} oldest
            </span>
            {isOG ? (
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
  isLoading: boolean;
  hasSearched: boolean;
  timing?: number;
  error?: string | null;
  scan?: ScanSummary | null;
}

export function Results({
  results,
  isLoading,
  hasSearched,
  timing,
  error,
  scan,
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

  if (error) {
    return (
      <div className="rounded-2xl border border-red-900/40 bg-red-950/20 px-5 py-8 text-center">
        <p className="text-sm font-medium text-red-300">{error}</p>
        <p className="mt-2 text-xs text-red-400/80">
          Try a name (2–30 chars) or a full Solana mint (32–44 characters).
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
          Try another name or paste a different mint
        </p>
      </div>
    );
  }

  if (results.length === 0) return null;

  return (
    <div>
      {scan && <ScanBanner scan={scan} />}

      <div className="mb-3 flex items-center justify-between px-1 text-xs text-gray-500">
        <span>
          {results.length} token{results.length !== 1 ? "s" : ""} found
          <span className="text-gray-700"> — oldest first</span>
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
