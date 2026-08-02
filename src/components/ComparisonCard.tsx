"use client";

import { useState, useRef, useEffect } from "react";
import { CompareState, CompareSideState } from "@/lib/compare";
import { formatDate, timeAgo, formatAgeGap } from "@/lib/format";
import { encodeComparePayload, ComparePayload } from "@/lib/share";
import {
  ConfidenceStars,
  PlatformBadge,
  RiskChips,
  HomoglyphBadge,
} from "./Badge";

function truncateMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function formatUsdVol(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Token price with sub-cent precision (e.g. $0.0000123 stays readable). */
function formatPrice(n: number): string {
  if (n >= 1) {
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  const fixed = n.toFixed(18);
  const m = fixed.match(/^0\.(0*)([1-9]\d*)$/);
  if (!m) return `$${n.toFixed(6)}`;
  return `$0.${m[1]}${m[2].slice(0, 3)}`;
}

function formatPct(n: number): string {
  const fixed = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${n >= 0 ? "+" : ""}${fixed}%`;
}

const RANK_TOOLTIP =
  "Rank within this token's OWN name search — the two sides run different searches, so ranks are not comparable across them";

function SideCard({
  side,
  older,
}: {
  side: CompareSideState;
  older: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const t = side.token;

  // Per-side error / no-data slot: keeps the other side rendering normally.
  if (side.error || !t) {
    return (
      <div className="flex flex-col justify-center rounded-xl border border-gray-800/70 bg-gray-900/40 px-3.5 py-3">
        <p className="font-mono text-[11px] text-cyan-300/90">
          {truncateMint(side.mint)}
        </p>
        <p
          className={`mt-1.5 text-xs ${
            side.error ? "text-red-300" : "text-gray-500"
          }`}
        >
          {side.error ??
            "This mint didn't appear in its own scan results."}
        </p>
      </div>
    );
  }

  const ago = timeAgo(t.createdAt);
  const showLogo = Boolean(t.imageUrl) && !logoFailed;
  const hasPrice = t.priceUsd != null && t.priceUsd > 0;
  const hasLiquidity = t.liquidityUsd != null && t.liquidityUsd > 0;
  const hasChange = t.priceChange24h != null;

  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${
        older
          ? "border-amber-500/60 bg-amber-950/15 ring-1 ring-amber-400/40"
          : "border-gray-800/70 bg-gray-900/40"
      }`}
    >
      <div className="flex items-center gap-2.5">
        {showLogo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.imageUrl!}
            alt={t.displayName}
            width={32}
            height={32}
            loading="lazy"
            onError={() => setLogoFailed(true)}
            className="h-8 w-8 rounded-lg object-cover ring-1 ring-gray-700/50"
          />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-gray-100">
            {t.displayName}
            <span className="ml-1.5 text-xs font-semibold text-gray-500">
              ${t.displaySymbol}
            </span>
          </p>
          <p className="truncate font-mono text-[10px] text-cyan-300/90">
            {truncateMint(side.mint)}
          </p>
        </div>
      </div>

      <p className="mt-2 text-xs text-gray-400">
        minted{" "}
        <span className="font-medium text-gray-300">
          {formatDate(t.createdAt)}
        </span>
        {ago && <span className="text-gray-600"> ({ago})</span>}
        {t.createdAtIsLowerBound && (
          <span
            className="ml-1.5 text-[10px] font-medium text-amber-500/80"
            title="Active token — creation may be older than shown"
          >
            may be older
          </span>
        )}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ConfidenceStars score={t.confidence} />
        <PlatformBadge dexId={t.dexId} mint={t.mint} />
        <RiskChips
          mintAuthorityActive={t.mintAuthorityActive}
          freezeAuthorityActive={t.freezeAuthorityActive}
          metadataMutable={t.metadataMutable}
        />
        {t.homoglyphSuspect && <HomoglyphBadge />}
      </div>

      {(hasPrice || hasLiquidity || hasChange) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          {hasPrice && (
            <span
              className="font-medium text-emerald-400/90"
              title="Price (USD, highest-liquidity pair)"
            >
              {formatPrice(t.priceUsd!)}
            </span>
          )}
          {hasLiquidity && (
            <span className="text-gray-500" title="DexScreener liquidity">
              {formatUsdVol(t.liquidityUsd!)} liq
            </span>
          )}
          {hasChange && (
            <span
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                t.priceChange24h! >= 0
                  ? "bg-emerald-950/50 text-emerald-400 ring-emerald-800/50"
                  : "bg-red-950/50 text-red-400 ring-red-800/50"
              }`}
              title="24h price change"
            >
              {formatPct(t.priceChange24h!)}
            </span>
          )}
        </div>
      )}

      {side.scannedRank != null && side.totalFound != null && (
        <p className="mt-2 text-[11px] text-gray-500" title={RANK_TOOLTIP}>
          {side.isScannedOG === true
            ? `OG of its own name search (#${side.scannedRank} of ${side.totalFound})`
            : `#${side.scannedRank} of ${side.totalFound} in its own name search`}
        </p>
      )}
    </div>
  );
}

/**
 * Head-to-head comparison of two mints, composed client-side from each
 * mint's own full scan. The only cross-token verdict is the age gap —
 * per-side ranks/verdicts belong to their own name searches.
 */
export function ComparisonCard({ state }: { state: CompareState }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  if (state.loading) {
    return (
      <div className="animate-pulse rounded-2xl border border-gray-800/60 bg-gray-900/40 p-5">
        <div className="mb-4 h-6 w-56 rounded-lg bg-gray-800/60" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-44 rounded-xl bg-gray-800/50" />
          <div className="h-44 rounded-xl bg-gray-800/50" />
        </div>
      </div>
    );
  }

  const aTok = state.a.token;
  const bTok = state.b.token;
  const aMs = aTok?.createdAtMs ?? null;
  const bMs = bTok?.createdAtMs ?? null;
  const winner: "a" | "b" | null =
    aMs != null && bMs != null && aMs !== bMs ? (aMs < bMs ? "a" : "b") : null;
  const gapMs = aMs != null && bMs != null ? Math.abs(aMs - bMs) : null;
  const winnerToken = winner === "a" ? aTok : winner === "b" ? bTok : null;
  const shareable = Boolean(aTok && bTok);

  const shareComparison = async () => {
    if (!aTok || !bTok) return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const payload: ComparePayload = {
      a: {
        n: aTok.displayName,
        s: aTok.displaySymbol,
        d: aTok.createdAt,
        m: state.a.mint,
      },
      b: {
        n: bTok.displayName,
        s: bTok.displaySymbol,
        d: bTok.createdAt,
        m: state.b.mint,
      },
      w: winner === "a" ? 0 : winner === "b" ? 1 : null,
    };
    // The ?q= auto-run re-parses "A vs B" and re-runs the comparison live.
    const url = `${window.location.origin}/?q=${encodeURIComponent(
      `${state.a.mint} vs ${state.b.mint}`
    )}&cv=${encodeComparePayload(payload)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyFailed(false);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      copyTimerRef.current = setTimeout(() => setCopyFailed(false), 2000);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-700/50 bg-gradient-to-br from-gray-900/70 via-gray-900/60 to-gray-900/40">
      <div className="p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-500/90">
              Head-to-head comparison
            </p>
            <h2 className="mt-1.5 text-xl font-black tracking-tight text-gray-100 sm:text-2xl">
              {winnerToken && gapMs != null ? (
                <>
                  <span className="text-amber-400">
                    {winnerToken.displayName}
                  </span>{" "}
                  is older by {formatAgeGap(gapMs)}
                </>
              ) : state.a.error || state.b.error ? (
                "Comparison incomplete"
              ) : aMs != null && bMs != null ? (
                "Same verified age"
              ) : (
                "No age verdict"
              )}
            </h2>
          </div>

          <button
            type="button"
            onClick={shareComparison}
            disabled={!shareable}
            title={
              shareable
                ? "Copy a shareable comparison link"
                : "Both mints must resolve before sharing"
            }
            className={`inline-flex flex-shrink-0 items-center gap-1.5 self-start rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              copied
                ? "border-emerald-500/50 bg-emerald-950/40 text-emerald-300"
                : copyFailed
                  ? "border-red-500/50 bg-red-950/40 text-red-300"
                  : "border-gray-700/80 bg-gray-900/60 text-gray-300 hover:border-gray-600 hover:bg-gray-800/70"
            }`}
          >
            <span className="sr-only" role="status">
              {copied ? "Link copied" : copyFailed ? "Copy failed" : ""}
            </span>
            {copied
              ? "Link copied"
              : copyFailed
                ? "Copy failed"
                : "Share comparison"}
          </button>
        </div>

        <div className="mt-4 grid gap-2.5 border-t border-gray-800/60 pt-4 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch sm:gap-3">
          <SideCard side={state.a} older={winner === "a"} />

          <div className="flex items-center justify-center px-1 text-center">
            {winner && gapMs != null ? (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-amber-500/80">
                  older by
                </p>
                <p className="text-sm font-bold text-gray-200">
                  {formatAgeGap(gapMs)}
                </p>
              </div>
            ) : (
              <p className="text-sm font-black tracking-widest text-gray-600">
                VS
              </p>
            )}
          </div>

          <SideCard side={state.b} older={winner === "b"} />
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-gray-600">
          Each side is ranked within its own name search — those ranks are not
          comparable across the two tokens. The verdict above compares verified
          on-chain creation times only.
        </p>
      </div>
    </section>
  );
}
