"use client";

import { useState } from "react";
import { TokenResult } from "@/lib/types";
import { OGBadge, ConfidenceStars, PlatformBadge, RankBadge } from "./Badge";

function truncateMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function formatDate(isoStr: string | null): string {
  if (!isoStr) return "Unknown";
  try {
    return new Date(isoStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown";
  }
}

function timeAgo(isoStr: string | null): string {
  if (!isoStr) return "";
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    const days = Math.floor(ms / 86400000);
    if (days < 1) return "today";
    if (days === 1) return "1 day ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    const rem = months % 12;
    if (rem === 0) return `${years}y ago`;
    return `${years}y ${rem}mo ago`;
  } catch {
    return "";
  }
}

export function TokenCard({ token }: { token: TokenResult }) {
  const [copied, setCopied] = useState(false);

  const copyMint = async () => {
    try {
      await navigator.clipboard.writeText(token.mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* */
    }
  };

  const isOG = token.rank === 1;
  const ago = timeAgo(token.createdAt);

  return (
    <div
      className={`rounded-2xl border p-4 sm:p-5 transition-all ${
        isOG
          ? "border-yellow-600/40 bg-yellow-950/20 og-glow"
          : "border-gray-800/80 bg-gray-900/40 hover:border-gray-700/80"
      }`}
    >
      <div className="flex gap-3 sm:gap-4">
        <RankBadge rank={token.rank} />

        <div className="min-w-0 flex-1 space-y-2.5">
          {/* Row 1: Name + badges */}
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-gray-100 sm:text-lg">
              {token.displayName}
            </h3>
            <span className="text-xs font-semibold text-gray-500 sm:text-sm">
              ${token.displaySymbol}
            </span>
            <OGBadge rank={token.rank} />
            <PlatformBadge dexId={token.dexId} />
          </div>

          {/* Row 2: Date + mint */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400 sm:text-sm">
            <span className="font-medium text-gray-300">
              {formatDate(token.createdAt)}
            </span>
            {ago && (
              <span className="text-gray-600">({ago})</span>
            )}
            <span className="text-gray-700">·</span>
            <button
              onClick={copyMint}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-800/60 px-2 py-0.5 font-mono text-[11px] text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-300"
              title={token.mint}
            >
              {truncateMint(token.mint)}
              <span className="text-[10px]">{copied ? "✅" : "📋"}</span>
            </button>
          </div>

          {/* Row 3: Confidence + links */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-1.5">
              <ConfidenceStars score={token.confidence} />
              <span className="text-[11px] text-gray-500">
                {token.confidenceLabel}
              </span>
            </div>

            <div className="flex gap-1.5 sm:ml-auto">
              <a
                href={`https://solscan.io/token/${token.mint}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-gray-800/70 px-2.5 py-1 text-[11px] font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-100"
              >
                Solscan
              </a>
              <a
                href={`https://birdeye.so/token/${token.mint}?chain=solana`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-gray-800/70 px-2.5 py-1 text-[11px] font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-100"
              >
                Birdeye
              </a>
              <a
                href={`https://dexscreener.com/solana/${token.mint}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg bg-gray-800/70 px-2.5 py-1 text-[11px] font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-100"
              >
                DEX
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
