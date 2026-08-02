"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Lottie, { LottieRefCurrentProps } from "lottie-react";
import { TokenResult } from "@/lib/types";
import { formatDate, timeAgo } from "@/lib/format";
import copyHover from "@/assets/lottie/copy-hover.json";
import {
  OGBadge,
  ConfidenceStars,
  PlatformBadge,
  RankBadge,
  ScannedMintBadge,
  BurnedBadge,
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
  // Sub-cent: keep 3 significant digits, never scientific notation.
  const fixed = n.toFixed(18);
  const m = fixed.match(/^0\.(0*)([1-9]\d*)$/);
  if (!m) return `$${n.toFixed(6)}`;
  return `$0.${m[1]}${m[2].slice(0, 3)}`;
}

function formatPct(n: number): string {
  const fixed = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  return `${n >= 0 ? "+" : ""}${fixed}%`;
}

export function TokenCard({ token }: { token: TokenResult }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const copyLottieRef = useRef<LottieRefCurrentProps>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyMint = async () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(token.mint);
      setCopyFailed(false);
      setCopied(true);
      copyLottieRef.current?.stop();
      copyLottieRef.current?.play();
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      copyTimerRef.current = setTimeout(() => setCopyFailed(false), 1500);
    }
  };

  const isOG = token.rank === 1 && token.rankingMode === "creation";
  const isScanned = token.isScanned === true;
  const ago = timeAgo(token.createdAt);
  const showLogo = Boolean(token.imageUrl) && !logoFailed;
  const hasPrice = token.priceUsd != null && token.priceUsd > 0;
  const hasLiquidity = token.liquidityUsd != null && token.liquidityUsd > 0;
  const hasChange = token.priceChange24h != null;
  const hasMarketRow = hasPrice || hasLiquidity || hasChange;

  return (
    <div
      className={`rounded-2xl border p-4 sm:p-5 transition-all ${
        isOG
          ? "border-yellow-600/40 bg-yellow-950/20 og-glow"
          : isScanned
            ? "border-cyan-600/35 bg-cyan-950/15 ring-1 ring-cyan-500/20"
            : "border-gray-800/80 bg-gray-900/40 hover:border-gray-700/80"
      }`}
    >
      <div className="flex gap-3 sm:gap-4">
        <div className="flex flex-shrink-0 flex-col items-center gap-2">
          <RankBadge rank={token.rank} />
          {showLogo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.imageUrl!}
              alt={token.displayName}
              width={40}
              height={40}
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="h-10 w-10 rounded-xl object-cover ring-1 ring-gray-700/50"
            />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2.5">
          {/* Row 1: Name + badges */}
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-gray-100 sm:text-lg">
              {token.displayName}
            </h3>
            <span className="text-xs font-semibold text-gray-500 sm:text-sm">
              ${token.displaySymbol}
            </span>
            {isScanned && <ScannedMintBadge />}
            {token.rankingMode === "creation" && (
              <OGBadge rank={token.rank} />
            )}
            {token.supplyZero && <BurnedBadge />}
            <PlatformBadge dexId={token.dexId} mint={token.mint} />
          </div>

          {/* Row 2: Date + mint */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400 sm:text-sm">
            {token.pendingAge ? (
              <span
                className="animate-pulse font-medium text-gray-600"
                title="On-chain age check in progress"
              >
                dating…
              </span>
            ) : (
              <span className="font-medium text-gray-300">
                {formatDate(token.createdAt)}
              </span>
            )}
            {token.createdAtIsLowerBound && (
              <span
                className="text-[10px] font-medium text-amber-500/80"
                title="Active token — creation may be older than shown"
              >
                may be older
              </span>
            )}
            {ago && (
              <span className="text-gray-600">({ago})</span>
            )}
            {token.rankingMode === "marketcap" &&
              (token.marketCapUsd ?? token.fdvUsd) != null &&
              (token.marketCapUsd ?? token.fdvUsd)! > 0 && (
                <>
                  <span className="text-gray-700">·</span>
                  <span
                    className="text-emerald-500/90"
                    title="DexScreener market cap or FDV"
                  >
                    MC {formatUsdVol((token.marketCapUsd ?? token.fdvUsd)!)}
                  </span>
                </>
              )}
            {token.rankingMode === "marketcap" &&
              token.volumeUsd24h != null &&
              token.volumeUsd24h > 0 && (
                <>
                  <span className="text-gray-700">·</span>
                  <span className="text-amber-500/90" title="DexScreener 24h volume">
                    Vol {formatUsdVol(token.volumeUsd24h)}
                  </span>
                </>
              )}
            {token.rankingMode === "volume" &&
              token.volumeUsd24h != null &&
              token.volumeUsd24h > 0 && (
                <>
                  <span className="text-gray-700">·</span>
                  <span className="text-amber-500/90" title="DexScreener 24h volume">
                    Vol {formatUsdVol(token.volumeUsd24h)}
                  </span>
                </>
              )}
            <span className="text-gray-700">·</span>
            <button
              type="button"
              onClick={copyMint}
              onMouseEnter={() => {
                if (!copied) {
                  copyLottieRef.current?.stop();
                  copyLottieRef.current?.play();
                }
              }}
              onMouseLeave={() => {
                if (!copied) {
                  copyLottieRef.current?.stop();
                  copyLottieRef.current?.goToAndStop(0, true);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-700/50 bg-gray-800/50 px-2 py-0.5 font-mono text-[11px] text-gray-400 transition-colors hover:border-gray-600 hover:bg-gray-800/80 hover:text-gray-200"
              title={
                copied
                  ? "Copied"
                  : copyFailed
                    ? "Copy failed"
                    : `Copy ${token.mint}`
              }
            >
              <span>{truncateMint(token.mint)}</span>
              {copied ? (
                <span className="text-[10px] font-medium text-emerald-400">
                  Copied
                </span>
              ) : copyFailed ? (
                <span className="text-[10px] font-medium text-red-400">
                  Copy failed
                </span>
              ) : (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                  <Lottie
                    lottieRef={copyLottieRef}
                    animationData={copyHover}
                    loop={false}
                    autoplay={false}
                    style={{ width: 28, height: 28 }}
                  />
                </span>
              )}
            </button>
          </div>

          {/* Row 2.5: Market data (price / liquidity / 24h change) */}
          {hasMarketRow && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {hasPrice && (
                <span
                  className="font-medium text-emerald-400/90"
                  title="Price (USD, highest-liquidity pair)"
                >
                  {formatPrice(token.priceUsd!)}
                </span>
              )}
              {hasLiquidity && (
                <span className="text-gray-500" title="DexScreener liquidity">
                  {formatUsdVol(token.liquidityUsd!)} liq
                </span>
              )}
              {hasChange && (
                <span
                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${
                    token.priceChange24h! >= 0
                      ? "bg-emerald-950/50 text-emerald-400 ring-emerald-800/50"
                      : "bg-red-950/50 text-red-400 ring-red-800/50"
                  }`}
                  title="24h price change"
                >
                  {formatPct(token.priceChange24h!)}
                </span>
              )}
            </div>
          )}

          {/* Row 3: Confidence + links */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-1.5">
              <ConfidenceStars score={token.confidence} />
              <span className="text-[11px] text-gray-500">
                {token.confidenceLabel}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
              <a
                href={`https://trade.padre.gg/trade/solana/${token.mint}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Trade on Padre Terminal"
                className="group inline-flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-950/35 px-2 py-1.5 shadow-sm shadow-emerald-950/20 transition-all hover:border-emerald-400/45 hover:bg-emerald-950/55 hover:shadow-emerald-900/30"
              >
                <Image
                  src="/padre.png"
                  alt=""
                  width={88}
                  height={18}
                  className="h-[18px] w-auto max-w-[5.75rem] object-contain object-left opacity-[0.92] transition-opacity group-hover:opacity-100"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400/90">
                  Trade
                </span>
                <span className="sr-only">Open Padre Terminal for this token</span>
              </a>
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
