"use client";

import { useState, useRef, useEffect } from "react";
import { CompareState, CompareSideState } from "@/lib/compare";
import { formatDate, timeAgo, formatAgeGap } from "@/lib/format";
import { encodeComparePayload, ComparePayload } from "@/lib/share";
import { blockingFlags, isDangerous } from "@/lib/safety-view";
import {
  Chip,
  ConfidenceStars,
  PlatformBadge,
  RiskChips,
  HomoglyphBadge,
  SafetyChips,
  SafetyFindingList,
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

const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

/** Sweep used by the loading state; parked by the reduced-motion block. */
function Shimmer() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/[0.045] to-transparent"
    />
  );
}

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
      <div className="flex flex-col justify-center rounded-xl border bg-surface-1 px-3.5 py-3">
        <p className="font-mono text-micro text-scan">
          {truncateMint(side.mint)}
        </p>
        <p
          className={`mt-1.5 text-meta ${
            side.error ? "text-down" : "text-fg-3"
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

  // A dangerous side never wears the gold winner treatment: on a card whose
  // whole job is "pick one", gold on a token that can block your sells reads
  // as "buy this one".
  const danger = isDangerous(t.safetyLevel);
  const blocking = danger ? blockingFlags(t.safetyFlags) : [];
  const goldWinner = older && !danger;

  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${
        danger
          ? "border-risk/40 bg-risk/[0.07]"
          : goldWinner
            ? "og-glow bg-og/[0.06]"
            : "bg-surface-1"
      }`}
    >
      <div className="flex items-center gap-2.5">
        {showLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.imageUrl!}
            alt={t.displayName}
            width={32}
            height={32}
            loading="lazy"
            onError={() => setLogoFailed(true)}
            className="h-8 w-8 shrink-0 rounded-lg border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-surface-2 font-display text-micro font-bold text-fg-4"
          >
            {t.displaySymbol?.charAt(0)?.toUpperCase() || "?"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-bold tracking-tight text-fg">
            {t.displayName}
            <span className="ml-1.5 font-mono text-micro font-normal text-fg-3">
              ${t.displaySymbol}
            </span>
          </p>
          <p className="truncate font-mono text-micro text-scan">
            {truncateMint(side.mint)}
          </p>
        </div>
        {older && (
          <Chip
            tone={goldWinner ? "og" : "risk"}
            className="font-semibold uppercase tracking-[0.14em]"
            title={
              goldWinner
                ? "Older by verified on-chain creation time"
                : "Older by verified on-chain creation time — and carrying blocking risk flags. Older does not mean safer."
            }
          >
            Older
          </Chip>
        )}
      </div>

      <p className="mt-2.5 text-meta text-fg-3">
        minted{" "}
        <span className="font-mono text-fg-2">{formatDate(t.createdAt)}</span>
        {ago && <span className="font-mono text-fg-4"> · {ago}</span>}
        {t.createdAtIsLowerBound && (
          <span
            className="ml-1.5 text-micro font-medium text-warn"
            title="Active token — creation may be older than shown"
          >
            may be older
          </span>
        )}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ConfidenceStars score={t.confidence} />
        <PlatformBadge dexId={t.dexId} mint={t.mint} />
        <SafetyChips level={t.safetyLevel} flags={t.safetyFlags} max={3} />
        {t.safetyLevel == null && (
          <RiskChips
            mintAuthorityActive={t.mintAuthorityActive}
            freezeAuthorityActive={t.freezeAuthorityActive}
            metadataMutable={t.metadataMutable}
          />
        )}
        {t.homoglyphSuspect && <HomoglyphBadge />}
      </div>

      {blocking.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-risk/25 bg-risk/[0.06] px-2.5 py-2">
          <SafetyFindingList flags={blocking} />
        </div>
      )}

      {(hasPrice || hasLiquidity || hasChange) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-meta">
          {hasPrice && (
            <span
              className="text-fg-2"
              title="Price (USD, highest-liquidity pair)"
            >
              {formatPrice(t.priceUsd!)}
            </span>
          )}
          {hasLiquidity && (
            <span className="text-fg-3" title="DexScreener liquidity">
              {formatUsdVol(t.liquidityUsd!)}
              <span className="text-fg-4"> liq</span>
            </span>
          )}
          {hasChange && (
            <Chip
              tone={t.priceChange24h! >= 0 ? "up" : "down"}
              className="font-mono"
              title="24h price change"
            >
              {formatPct(t.priceChange24h!)}
            </Chip>
          )}
        </div>
      )}

      {side.scannedRank != null && side.totalFound != null && (
        <p className="mt-2.5 text-micro text-fg-4" title={RANK_TOOLTIP}>
          {side.isScannedOG !== true
            ? `#${side.scannedRank} of ${side.totalFound} in its own name search`
            : danger
              ? // Same fact, no endorsement: "OG of…" is the word we withhold.
                `Oldest in its own name search (#${side.scannedRank} of ${side.totalFound})`
              : `OG of its own name search (#${side.scannedRank} of ${side.totalFound})`}
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
      <div className="relative overflow-hidden rounded-2xl border bg-surface-1 p-5">
        <div className="mb-4 space-y-3">
          <div className="h-3 w-32 rounded-md bg-surface-3" />
          <div className="h-7 w-64 rounded-lg bg-surface-2" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-44 rounded-xl bg-surface-2/80" />
          <div className="h-44 rounded-xl bg-surface-2/80" />
        </div>
        <Shimmer />
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
  const winnerDanger = isDangerous(winnerToken?.safetyLevel);
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
    <section className="overflow-hidden rounded-2xl border bg-surface-1">
      {/* ── Verdict ─────────────────────────────────────────────────────── */}
      <div className="p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className={`${EYEBROW} text-scan`}>Head-to-head comparison</p>
            <h2 className="mt-2 font-display text-[26px] font-bold leading-[1.1] tracking-tight text-fg sm:text-[32px]">
              {winnerToken && gapMs != null ? (
                <>
                  <span className={winnerDanger ? "text-risk" : "text-og"}>
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
            {winnerDanger && (
              <p className="mt-2 max-w-prose text-meta leading-relaxed text-fg-2">
                Age only. The older token carries blocking risk flags (listed on
                its card) —{" "}
                <span className="font-semibold text-fg">
                  older does not mean safer, and OGfinder is not endorsing it.
                </span>
              </p>
            )}
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
            className={`inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 self-start rounded-xl border px-3 py-1.5 text-meta font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 ${
              copied
                ? "border-up/40 bg-up/10 text-up"
                : copyFailed
                  ? "border-down/40 bg-down/10 text-down"
                  : "bg-surface-2 text-fg-2 hover:border-line-str hover:text-fg"
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
      </div>

      {/* ── Sides ───────────────────────────────────────────────────────── */}
      <div className="border-t bg-bg/50 px-4 py-4 sm:px-6">
        <div className="grid gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch sm:gap-3">
          <SideCard side={state.a} older={winner === "a"} />

          <div className="flex items-center justify-center px-1 text-center">
            {winner && gapMs != null ? (
              <div>
                <p
                  className={`${EYEBROW} ${
                    winnerDanger ? "text-fg-4" : "text-og"
                  }`}
                >
                  older by
                </p>
                <p className="mt-1 font-display text-lg font-bold tracking-tight text-fg sm:text-xl">
                  {formatAgeGap(gapMs)}
                </p>
              </div>
            ) : (
              <p className="font-display text-sm font-bold tracking-[0.3em] text-fg-4">
                VS
              </p>
            )}
          </div>

          <SideCard side={state.b} older={winner === "b"} />
        </div>

        <p className="mt-3 text-micro leading-relaxed text-fg-4">
          Each side is ranked within its own name search — those ranks are not
          comparable across the two tokens. The verdict above compares verified
          on-chain creation times only.
        </p>
      </div>
    </section>
  );
}
