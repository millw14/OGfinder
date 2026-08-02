"use client";

import { useState, useRef, useEffect } from "react";
import { TokenResult, ScanSummary } from "@/lib/types";
import { formatDate, timeAgo } from "@/lib/format";
import { encodeSharePayload, SharePayload } from "@/lib/share";
import { LottieHover } from "./LottieHover";
import crownOg from "@/assets/lottie/crown-og.json";

function truncateMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

/** Age gap between the OG and the scanned mint: "2y 3mo" / "8mo" / "12 days". */
function formatAgeGap(gapMs: number): string {
  const days = Math.floor(gapMs / 86400000);
  if (days < 1) return "less than a day";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years}y` : `${years}y ${rem}mo`;
}

interface ScanHeroProps {
  scan: ScanSummary;
  /** Full creation-ranked (unfiltered) result list — ranked[0] is the OG. */
  ranked: TokenResult[];
  totalCount: number;
  hiddenByFilter: boolean;
}

/**
 * Verdict hero for CA scans. The verdict itself (isScannedOG / scannedRank)
 * is the server's — never recomputed here.
 */
export function ScanHero({
  scan,
  ranked,
  totalCount,
  hiddenByFilter,
}: ScanHeroProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  if (scan.mode !== "scan" || !scan.scannedMint) return null;

  const scannedMint = scan.scannedMint;
  const scanned = ranked.find((t) => t.mint === scannedMint) ?? null;
  const og = ranked.length > 0 ? ranked[0] : null;
  const isOG = scan.isScannedOG === true;
  const rank = scan.scannedRank ?? null;

  const name = scanned?.displayName ?? scan.scanName ?? "Unknown token";
  const symbol = scanned?.displaySymbol ?? scan.scanSymbol ?? null;

  // Edge cases keep the slim banner treatment instead of the full hero.
  if (hiddenByFilter || rank == null) {
    const label =
      scan.scanName && scan.scanSymbol
        ? `${scan.scanName} ($${scan.scanSymbol})`
        : scan.scanName ?? scan.scanSymbol ?? "Token";
    return (
      <div className="mb-4 rounded-2xl border border-cyan-900/40 bg-gradient-to-br from-cyan-950/30 to-gray-900/50 p-4 sm:p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-500/90">
          Contract scan
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-gray-300 sm:text-base">
          Resolved <span className="font-medium text-gray-100">{label}</span>
          {hiddenByFilter ? (
            <span className="text-gray-500">
              {" "}
              — your mint doesn’t match the selected launchpad filters. Clear
              filters to see it in the full list.
            </span>
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

  const ago = timeAgo(scanned?.createdAt ?? null);
  const ogAgo = og ? timeAgo(og.createdAt) : "";
  const gapMs =
    og?.createdAtMs != null && scanned?.createdAtMs != null
      ? scanned.createdAtMs - og.createdAtMs
      : null;
  const showLogo = Boolean(scanned?.imageUrl) && !logoFailed;

  const shareVerdict = async () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const payload: SharePayload = {
      n: name,
      s: symbol ?? "",
      d: scanned?.createdAt ?? null,
      r: rank,
      t: totalCount,
      o: isOG,
      m: scannedMint,
    };
    const url = `${window.location.origin}/?q=${encodeURIComponent(
      scannedMint
    )}&v=${encodeSharePayload(payload)}`;
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
    <section
      className={`mb-4 overflow-hidden rounded-2xl border ${
        isOG
          ? "border-yellow-600/40 bg-gradient-to-br from-yellow-950/30 via-gray-900/60 to-gray-900/40 og-glow"
          : "border-red-900/40 bg-gradient-to-br from-red-950/20 via-gray-900/60 to-gray-900/40"
      }`}
    >
      <div className="p-4 sm:p-6">
        <p
          className={`text-[11px] font-semibold uppercase tracking-wider ${
            isOG ? "text-yellow-500/90" : "text-red-400/80"
          }`}
        >
          Contract scan verdict
        </p>

        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3 sm:gap-4">
            {isOG ? (
              <span className="og-badge-crown flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-yellow-900/40 ring-1 ring-yellow-600/50 sm:h-14 sm:w-14">
                <LottieHover animationData={crownOg} size={36} />
              </span>
            ) : (
              <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-red-950/60 text-sm font-black text-red-400 ring-1 ring-red-800/50 sm:h-14 sm:w-14 sm:text-base">
                #{rank}
              </span>
            )}
            <div>
              <h2
                className={`text-2xl font-black uppercase tracking-tight sm:text-3xl ${
                  isOG ? "text-yellow-400" : "text-gray-200"
                }`}
              >
                {isOG ? "This is the OG" : "Not the OG"}
              </h2>
              <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">
                {isOG ? (
                  <>
                    Oldest of{" "}
                    <span className="tabular-nums text-gray-300">
                      {totalCount}
                    </span>{" "}
                    matching tokens
                  </>
                ) : (
                  <>
                    <span className="font-semibold tabular-nums text-red-400/90">
                      #{rank}
                    </span>{" "}
                    of <span className="tabular-nums">{totalCount}</span> by age
                  </>
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={shareVerdict}
            title="Copy a shareable verdict link"
            className={`inline-flex flex-shrink-0 items-center gap-1.5 self-start rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              copied
                ? "border-emerald-500/50 bg-emerald-950/40 text-emerald-300"
                : copyFailed
                  ? "border-red-500/50 bg-red-950/40 text-red-300"
                  : isOG
                    ? "border-yellow-600/50 bg-yellow-950/40 text-yellow-300 hover:border-yellow-500/70 hover:bg-yellow-950/70"
                    : "border-gray-700/80 bg-gray-900/60 text-gray-300 hover:border-gray-600 hover:bg-gray-800/70"
            }`}
          >
            {copied ? "Link copied" : copyFailed ? "Copy failed" : "Share verdict"}
          </button>
        </div>

        {/* Scanned token identity */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-gray-800/60 pt-4">
          {showLogo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={scanned!.imageUrl!}
              alt={name}
              width={36}
              height={36}
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="h-9 w-9 rounded-lg object-cover ring-1 ring-gray-700/50"
            />
          )}
          <span className="text-base font-bold text-gray-100">{name}</span>
          {symbol && (
            <span className="text-xs font-semibold text-gray-500">
              ${symbol}
            </span>
          )}
          <span className="text-gray-700">·</span>
          <span className="text-xs text-gray-400">
            minted{" "}
            <span className="font-medium text-gray-300">
              {formatDate(scanned?.createdAt ?? null)}
            </span>
          </span>
          {ago && <span className="text-xs text-gray-600">({ago})</span>}
          {scanned?.createdAtIsLowerBound && (
            <span
              className="text-[10px] font-medium text-amber-500/80"
              title="Active token — creation may be older than shown"
            >
              may be older
            </span>
          )}
          <span className="font-mono text-[11px] text-cyan-300/90">
            {truncateMint(scannedMint)}
          </span>
        </div>
      </div>

      {/* Side-by-side comparison vs the actual #1 */}
      {!isOG && og && og.mint !== scannedMint && (
        <div className="border-t border-gray-800/60 bg-gray-950/40 px-4 py-4 sm:px-6">
          <div className="grid gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch sm:gap-3">
            <div className="rounded-xl border border-cyan-900/40 bg-cyan-950/15 px-3.5 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-500/90">
                Your token
              </p>
              <p className="mt-1 truncate text-sm font-bold text-gray-100">
                {name}
                {symbol && (
                  <span className="ml-1.5 text-xs font-semibold text-gray-500">
                    ${symbol}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-gray-400">
                {formatDate(scanned?.createdAt ?? null)}
                {ago && <span className="text-gray-600"> ({ago})</span>}
              </p>
            </div>

            <div className="flex items-center justify-center px-1 text-center">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-gray-600">
                  OG is older by
                </p>
                <p className="text-sm font-bold text-gray-300">
                  {gapMs != null && gapMs > 0 ? formatAgeGap(gapMs) : "—"}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-yellow-700/40 bg-yellow-950/15 px-3.5 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-500/90">
                The OG — #1 by age
              </p>
              <p className="mt-1 truncate text-sm font-bold text-gray-100">
                {og.displayName}
                <span className="ml-1.5 text-xs font-semibold text-gray-500">
                  ${og.displaySymbol}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-gray-400">
                {formatDate(og.createdAt)}
                {ogAgo && <span className="text-gray-600"> ({ogAgo})</span>}
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
