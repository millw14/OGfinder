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
  ExactNameBadge,
  HomoglyphBadge,
  ProvenanceBadge,
  RiskChips,
  Chip,
} from "./Badge";

/** Hover copy for the rank-gated OG labels (creation ranking, rank 1 only). */
const OG_LABEL_TITLES: Record<string, string> = {
  OG: "Oldest matching token — exact name match, clear age gap to #2, verified age data",
  "Likely OG":
    "Oldest matching token, but the age gap to #2 is small or the name match is fuzzy",
  "Oldest found":
    "Oldest we could verify — its true creation may be older than shown",
};

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

/** Hairline dot separator between meta values. */
function Dot() {
  return (
    <span aria-hidden className="text-fg-4">
      ·
    </span>
  );
}

const EXPLORER_LINK =
  "rounded-lg border bg-surface-2 px-2.5 py-1 text-micro font-medium text-fg-3 transition-colors hover:border-line-str hover:bg-surface-3 hover:text-fg";

/** Three 44px rows + hairlines — used to decide whether the menu must flip up. */
const MENU_HEIGHT = 140;

export function TokenCard({ token }: { token: TokenResult }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Last card on screen: open the menu upward so it stays in the viewport. */
  const [menuDropUp, setMenuDropUp] = useState(false);
  const copyLottieRef = useRef<LottieRefCurrentProps>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Mobile overflow menu: close on Escape and on any press outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    setMenuDropUp(
      rect != null && window.innerHeight - rect.bottom < MENU_HEIGHT + 16
    );
    setMenuOpen(true);
  };

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
  // MC / volume are ranking-mode gated, and they share the market row, so the
  // row has to open for them too.
  const mcValue = token.marketCapUsd ?? token.fdvUsd;
  const showMarketCap =
    token.rankingMode === "marketcap" && mcValue != null && mcValue > 0;
  const showVolume =
    (token.rankingMode === "marketcap" || token.rankingMode === "volume") &&
    token.volumeUsd24h != null &&
    token.volumeUsd24h > 0;
  const hasMarketRow =
    hasPrice || hasLiquidity || hasChange || showMarketCap || showVolume;

  const tradeHref = `https://trade.padre.gg/trade/solana/${token.mint}`;
  const solscanHref = `https://solscan.io/token/${token.mint}`;
  const birdeyeHref = `https://birdeye.so/token/${token.mint}?chain=solana`;
  const dexHref = `https://dexscreener.com/solana/${token.mint}`;

  return (
    <article
      className={`rounded-2xl border p-4 transition-colors sm:p-5 ${
        isOG
          ? "og-glow bg-gradient-to-br from-og/[0.08] via-surface-1 to-surface-1"
          : isScanned
            ? "scan-ring bg-surface-1"
            : "bg-surface-1 hover:border-line-str"
      }`}
    >
      <div className="flex gap-3 sm:gap-4">
        {/* Rank rail */}
        <div className="flex w-10 flex-shrink-0 flex-col items-center gap-2">
          <RankBadge rank={token.rank} />
          {showLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.imageUrl!}
              alt={token.displayName}
              width={40}
              height={40}
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="h-10 w-10 rounded-xl border object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-xl border bg-surface-2 font-display text-sm font-bold text-fg-4"
            >
              {token.displaySymbol?.charAt(0)?.toUpperCase() || "?"}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {/* Row 1: identity */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <h3 className="font-display text-[15px] font-bold tracking-tight text-fg sm:text-base">
              {token.displayName}
            </h3>
            <span className="font-mono text-meta text-fg-3">
              ${token.displaySymbol}
            </span>
            {isScanned && <ScannedMintBadge />}
            {token.rankingMode === "creation" && (
              <OGBadge rank={token.rank} />
            )}
            {token.exactMatch && token.rank !== 1 && <ExactNameBadge />}
          </div>

          {/* Row 2: age + mint */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-fg-3">
            {token.pendingAge ? (
              <span
                className="animate-pulse font-medium text-fg-4"
                title="On-chain age check in progress"
              >
                dating…
              </span>
            ) : (
              <span className="font-mono text-fg-2">
                {formatDate(token.createdAt)}
              </span>
            )}
            {ago && <span className="font-mono text-fg-4">{ago}</span>}
            {token.createdAtIsLowerBound && (
              <span
                className="text-micro font-medium text-warn"
                title="Active token — creation may be older than shown"
              >
                may be older
              </span>
            )}
            <Dot />
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
              className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-micro transition-colors sm:min-h-0 ${
                copied
                  ? "border-up/40 bg-up/10 text-up"
                  : copyFailed
                    ? "border-down/40 bg-down/10 text-down"
                    : "bg-surface-2 text-fg-3 hover:border-line-str hover:bg-surface-3 hover:text-fg"
              }`}
              title={
                copied
                  ? "Copied"
                  : copyFailed
                    ? "Copy failed"
                    : `Copy ${token.mint}`
              }
            >
              <span className="sr-only" role="status">
                {copied ? "Copied" : copyFailed ? "Copy failed" : ""}
              </span>
              <span>{truncateMint(token.mint)}</span>
              {copied ? (
                <span className="text-micro font-medium">Copied</span>
              ) : copyFailed ? (
                <span className="text-micro font-medium">Copy failed</span>
              ) : (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Lottie
                    lottieRef={copyLottieRef}
                    animationData={copyHover}
                    loop={false}
                    autoplay={false}
                    style={{ width: 22, height: 22 }}
                  />
                </span>
              )}
            </button>
          </div>

          {/* Row 3: market data */}
          {hasMarketRow && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-meta">
              {showMarketCap && (
                <span className="text-fg-2" title="DexScreener market cap or FDV">
                  <span className="text-fg-4">MC </span>
                  {formatUsdVol(mcValue!)}
                </span>
              )}
              {hasPrice && (
                <span
                  className="text-fg-2"
                  title="Price (USD, highest-liquidity pair)"
                >
                  {formatPrice(token.priceUsd!)}
                </span>
              )}
              {hasLiquidity && (
                <>
                  {(showMarketCap || hasPrice) && <Dot />}
                  <span className="text-fg-3" title="DexScreener liquidity">
                    {formatUsdVol(token.liquidityUsd!)}
                    <span className="text-fg-4"> liq</span>
                  </span>
                </>
              )}
              {showVolume && (
                <>
                  {(showMarketCap || hasPrice || hasLiquidity) && <Dot />}
                  <span className="text-fg-3" title="DexScreener 24h volume">
                    {formatUsdVol(token.volumeUsd24h!)}
                    <span className="text-fg-4"> vol</span>
                  </span>
                </>
              )}
              {hasChange && (
                <Chip
                  tone={token.priceChange24h! >= 0 ? "up" : "down"}
                  className="font-mono"
                  title="24h price change"
                >
                  {formatPct(token.priceChange24h!)}
                </Chip>
              )}
            </div>
          )}

          {/* Row 4: venue / risk badges — collapses when nothing renders */}
          <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
            <PlatformBadge dexId={token.dexId} mint={token.mint} />
            <RiskChips
              mintAuthorityActive={token.mintAuthorityActive}
              freezeAuthorityActive={token.freezeAuthorityActive}
              metadataMutable={token.metadataMutable}
            />
            {token.linkProvenance && <ProvenanceBadge />}
            {token.homoglyphSuspect && <HomoglyphBadge />}
            {token.supplyZero && <BurnedBadge />}
          </div>

          {/* Row 5: confidence + actions */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5">
            <div className="flex items-center gap-1.5">
              <ConfidenceStars score={token.confidence} />
              {token.confidenceLabel && (
                <span
                  className="text-micro text-fg-3"
                  title={OG_LABEL_TITLES[token.confidenceLabel]}
                >
                  {token.confidenceLabel}
                </span>
              )}
            </div>

            <div className="hidden flex-wrap items-center gap-1.5 sm:ml-auto sm:flex">
              <a
                href={tradeHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Trade on Padre Terminal"
                className="group inline-flex items-center gap-2 rounded-lg border border-og/30 bg-og/10 px-2.5 py-1 transition-colors hover:border-og/50 hover:bg-og/[0.16]"
              >
                <Image
                  src="/padre.png"
                  alt=""
                  width={88}
                  height={18}
                  className="h-[16px] w-auto max-w-[5.75rem] object-contain object-left opacity-80 transition-opacity group-hover:opacity-100"
                />
                <span className="text-micro font-semibold uppercase tracking-[0.12em] text-og">
                  Trade
                </span>
                <span className="sr-only">Open Padre Terminal for this token</span>
              </a>
              <a
                href={solscanHref}
                target="_blank"
                rel="noopener noreferrer"
                className={EXPLORER_LINK}
              >
                Solscan
              </a>
              <a
                href={birdeyeHref}
                target="_blank"
                rel="noopener noreferrer"
                className={EXPLORER_LINK}
              >
                Birdeye
              </a>
              <a
                href={dexHref}
                target="_blank"
                rel="noopener noreferrer"
                className={EXPLORER_LINK}
              >
                DEX
              </a>
            </div>

            {/* Mobile: primary Trade link + "•••" overflow menu (44px targets). */}
            <div
              ref={menuRef}
              className="relative ml-auto flex items-center gap-1.5 sm:hidden"
            >
              <a
                href={tradeHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Trade on Padre Terminal"
                className="group inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-og/30 bg-og/10 px-3 transition-colors hover:border-og/50 hover:bg-og/[0.16]"
              >
                <Image
                  src="/padre.png"
                  alt=""
                  width={88}
                  height={18}
                  className="h-[16px] w-auto max-w-[5.75rem] object-contain object-left opacity-80 transition-opacity group-hover:opacity-100"
                />
                <span className="text-micro font-semibold uppercase tracking-[0.12em] text-og">
                  Trade
                </span>
                <span className="sr-only">Open Padre Terminal for this token</span>
              </a>
              <button
                ref={menuButtonRef}
                type="button"
                onClick={toggleMenu}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More explorer links"
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border text-sm font-bold transition-colors ${
                  menuOpen
                    ? "border-line-str bg-surface-3 text-fg"
                    : "bg-surface-2 text-fg-3 hover:border-line-str hover:text-fg"
                }`}
              >
                •••
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  aria-label="Explorer links"
                  className={`absolute right-0 z-20 w-44 overflow-hidden rounded-xl border border-line-str bg-surface-2 shadow-2xl shadow-black/60 ${
                    menuDropUp ? "bottom-full mb-1.5" : "top-full mt-1.5"
                  }`}
                >
                  <a
                    role="menuitem"
                    href={solscanHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-[44px] items-center px-4 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
                  >
                    Solscan
                  </a>
                  <a
                    role="menuitem"
                    href={birdeyeHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-[44px] items-center border-t px-4 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
                  >
                    Birdeye
                  </a>
                  <a
                    role="menuitem"
                    href={dexHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-[44px] items-center border-t px-4 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
                  >
                    DEX
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
