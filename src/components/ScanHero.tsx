"use client";

import { useState, useRef, useEffect } from "react";
import {
  TokenResult,
  ScanSummary,
  SERIAL_DEPLOYER_MIN,
  FRESH_WALLET_MS,
  TOKENS_CREATED_CAP,
} from "@/lib/types";
import {
  formatAgeAgo,
  formatAgeGap,
  UNPROVEN_ORDER_TITLE,
} from "@/lib/format";
import {
  encodeSafetyMarker,
  encodeSharePayload,
  SharePayload,
  UNPROVEN_MARKER,
} from "@/lib/share";
import {
  blockingFlags,
  headlineBlockingFlag,
  isDangerous,
} from "@/lib/safety-view";
import { LottieHover } from "./LottieHover";
import {
  CreationDate,
  RiskChips,
  HolderConcChip,
  SafetyChips,
  SafetyFindingList,
} from "./Badge";
import { WatchButton } from "./WatchButton";
import crownOg from "@/assets/lottie/crown-og.json";

function truncateMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

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
  /** Fast-phase verdict — ages unverified, so no definitive OG/NOT state yet. */
  const preliminary = scan.verdictPreliminary === true;

  const name = scanned?.displayName ?? scan.scanName ?? "Unknown token";
  const symbol = scanned?.displaySymbol ?? scan.scanSymbol ?? null;

  // Edge cases keep the slim banner treatment instead of the full hero.
  if (hiddenByFilter || rank == null) {
    const label =
      scan.scanName && scan.scanSymbol
        ? `${scan.scanName} ($${scan.scanSymbol})`
        : scan.scanName ?? scan.scanSymbol ?? "Token";
    return (
      <div className="mb-4 rounded-2xl border border-l-2 border-l-scan/60 bg-surface-1 p-4 sm:p-5">
        <p className={`${EYEBROW} text-scan`}>Contract scan</p>
        <p className="mt-2 text-sm leading-relaxed text-fg-2">
          Resolved <span className="font-medium text-fg">{label}</span>
          {hiddenByFilter ? (
            <span className="text-fg-3">
              {" "}
              — your mint doesn’t match the selected launchpad filters. Clear
              filters to see it in the full list.
            </span>
          ) : (
            <span className="text-fg-3">
              {" "}
              — this mint didn’t appear in the ranked results (try searching by
              name).
            </span>
          )}
        </p>
      </div>
    );
  }

  // Resolved scan name drives the clone-cluster watch; hidden when the name
  // is unresolved or outside the server's 2-30 char watch bounds.
  const watchQuery =
    scanned?.displayName ?? scan.scanName ?? null;
  const canWatch =
    watchQuery !== null &&
    watchQuery.trim().length >= 2 &&
    watchQuery.trim().length <= 30;

  // ── The verdict states ────────────────────────────────────────────────────
  // The server's age verdict (isOG) is never recomputed; safety and order
  // confidence only decide whether that fact earns the gold endorsement.
  //   endorsed  — oldest, no blocking flag, order proven → gold + crown
  //   unsafeOG  — oldest BUT blocking flag  → red "Oldest by age — but unsafe"
  //   unprovenOG— oldest BUT some ranked-below token's age is still a lower
  //               bound and could predate it → amber "Oldest known — not proven"
  //   !isOG     — not the oldest            → existing treatment + chips
  const scannedDanger = isDangerous(scanned?.safetyLevel);
  const scannedBlocking = scannedDanger
    ? blockingFlags(scanned?.safetyFlags)
    : [];
  // Server verdict first; the rank-1 stamp on the results is the same fact,
  // and covers payloads that predate the response-level field.
  const orderUnproven =
    scan.ageOrderUnproven === true || ranked[0]?.ageOrderUnproven === true;
  const unsafeOG = isOG && scannedDanger;
  const unprovenOG = isOG && !scannedDanger && orderUnproven;
  const endorsed = isOG && !scannedDanger && !orderUnproven;
  // The user is choosing between two tokens, so the OG's safety matters as
  // much as their own — and a dangerous #1 never gets the gold panel either.
  const ogDanger = isDangerous(og?.safetyLevel);

  // How many tokens block the proof. The server's count is authoritative (it
  // ranks the cohort before slicing to MAX_RESULTS); the local tally is the
  // fallback for payloads that predate the field. Neither is presented as
  // exhaustive — the copy says "N tokens have", never "only N".
  const unresolvedShown = ranked.filter(
    (t) => t.createdAtIsLowerBound === true
  ).length;
  const unresolvedCount = scan.ageUnresolvedCount ?? unresolvedShown;

  const ago = formatAgeAgo(
    scanned?.createdAt ?? null,
    scanned?.createdAtIsLowerBound === true
  );
  const ogAgo = og ? formatAgeAgo(og.createdAt, og.createdAtIsLowerBound) : "";
  const gapMs =
    og?.createdAtMs != null && scanned?.createdAtMs != null
      ? scanned.createdAtMs - og.createdAtMs
      : null;
  // A gap between two dates is only exact when BOTH are exact. With the #1 a
  // bound, the true gap is at least this big; with the scanned token a bound,
  // at most this big (and it can even flip sign — which is the unproven state
  // the panel above already spells out). With both, it is unknowable.
  const ogBound = og?.createdAtIsLowerBound === true;
  const scannedBound = scanned?.createdAtIsLowerBound === true;
  const gapUnknown = ogBound && scannedBound;
  const gapQualifier = gapUnknown
    ? ""
    : ogBound
      ? "at least "
      : scannedBound
        ? "at most "
        : "";
  const showLogo = Boolean(scanned?.imageUrl) && !logoFailed;

  const shareVerdict = async () => {
    if (preliminary) return;
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
    // ?sf= rides BESIDE ?v= (the ?v= payload contract is frozen) so the share
    // card can swap its gold band for a named mechanism.
    const marker = scannedDanger
      ? headlineBlockingFlag(scanned?.safetyFlags)
      : null;
    const sf = marker
      ? `&sf=${encodeURIComponent(encodeSafetyMarker(marker.code))}`
      : "";
    // ?u=1 rides beside ?v= the same way: the unfurled card must not show a
    // gold "OG" band for an ordering we have not proven.
    const u = isOG && orderUnproven ? `&u=${UNPROVEN_MARKER}` : "";
    const url = `${window.location.origin}/?q=${encodeURIComponent(
      scannedMint
    )}&v=${encodeSharePayload(payload)}${sf}${u}`;
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
        preliminary
          ? "bg-surface-1"
          : endorsed
            ? "og-glow bg-gradient-to-br from-og/[0.10] via-surface-1 to-surface-1"
            : unsafeOG
              ? "border-risk/45 bg-gradient-to-br from-risk/[0.12] via-surface-1 to-surface-1"
              : unprovenOG
                ? "border-warn/40 bg-gradient-to-br from-warn/[0.09] via-surface-1 to-surface-1"
                : "border-risk/25 bg-gradient-to-br from-risk/[0.07] via-surface-1 to-surface-1"
      }`}
    >
      {/* ── Verdict ─────────────────────────────────────────────────────── */}
      <div className="p-4 sm:p-6">
        <p
          className={`${EYEBROW} ${
            preliminary
              ? "text-fg-4"
              : endorsed
                ? "text-og"
                : unprovenOG
                  ? "text-warn"
                  : "text-risk"
          }`}
        >
          Contract scan verdict
        </p>

        <div className="mt-3 flex items-center gap-3 sm:gap-4">
          {preliminary ? (
            <span className="flex h-12 w-12 flex-shrink-0 animate-pulse items-center justify-center rounded-2xl border bg-surface-2 font-mono text-sm text-fg-3 sm:h-14 sm:w-14 sm:text-base">
              #{rank}
            </span>
          ) : endorsed ? (
            <span className="og-badge-crown flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border border-og/35 bg-og/[0.12] sm:h-14 sm:w-14">
              <LottieHover animationData={crownOg} size={34} />
            </span>
          ) : unprovenOG ? (
            // Oldest we could date — but the crown is an assertion, and the
            // ordering behind it is not established yet.
            <span className="flex h-12 min-w-[3rem] flex-shrink-0 items-center justify-center rounded-2xl border border-warn/35 bg-warn/[0.10] px-3 font-mono text-lg font-medium text-warn sm:h-14 sm:min-w-[3.5rem] sm:text-xl">
              #{rank}
            </span>
          ) : (
            // No crown for an unsafe #1 — but the rank itself still shows,
            // because the age finding is true and we never hide it.
            <span className="flex h-12 min-w-[3rem] flex-shrink-0 items-center justify-center rounded-2xl border border-risk/25 bg-risk/[0.08] px-3 font-mono text-lg font-medium text-risk sm:h-14 sm:min-w-[3.5rem] sm:text-xl">
              #{rank}
            </span>
          )}

          <div className="min-w-0">
            <h2
              className={`font-display font-bold uppercase leading-[1.05] tracking-tight ${
                unsafeOG || unprovenOG
                  ? "text-[26px] sm:text-[34px]"
                  : "text-[30px] sm:text-[40px]"
              } ${
                preliminary
                  ? "animate-pulse text-fg-3"
                  : endorsed
                    ? "text-og"
                    : unsafeOG
                      ? "text-risk"
                      : unprovenOG
                        ? "text-warn"
                        : "text-fg"
              }`}
            >
              {preliminary
                ? "Verifying…"
                : endorsed
                  ? "This is the OG"
                  : unsafeOG
                    ? "Oldest by age — but unsafe"
                    : unprovenOG
                      ? "Oldest known — not proven"
                      : "Not the OG"}
            </h2>
            <p className="mt-1.5 text-meta text-fg-3 sm:text-sm">
              {preliminary ? (
                <>
                  Checking on-chain ages of{" "}
                  <span className="font-mono text-fg-2">{totalCount}</span>{" "}
                  matching tokens
                </>
              ) : unprovenOG ? (
                <span title={UNPROVEN_ORDER_TITLE}>
                  Oldest of the{" "}
                  <span className="font-mono text-fg-2">{totalCount}</span>{" "}
                  matching tokens we could date completely —{" "}
                  {unresolvedCount > 0 ? (
                    <>
                      <span className="font-mono text-warn">
                        {unresolvedCount}
                      </span>{" "}
                      token{unresolvedCount === 1 ? "" : "s"} still ha
                      {unresolvedCount === 1 ? "s" : "ve"} an unresolved age
                    </>
                  ) : (
                    <>at least one still has an unresolved age</>
                  )}
                </span>
              ) : isOG ? (
                <>
                  Oldest of{" "}
                  <span className="font-mono text-fg-2">{totalCount}</span>{" "}
                  matching tokens
                </>
              ) : (
                <>
                  <span className="font-mono font-medium text-risk">
                    #{rank}
                  </span>{" "}
                  of <span className="font-mono text-fg-2">{totalCount}</span> by
                  age
                </>
              )}
            </p>
          </div>
        </div>

        {/* Blocking findings, spelled out — the mechanism and what it does to
            a holder. Shown whenever the scanned token is dangerous, whether or
            not it is also the oldest. */}
        {!preliminary && scannedBlocking.length > 0 && (
          <div className="mt-4 rounded-xl border border-risk/30 bg-risk/[0.07] p-3.5 sm:p-4">
            <p className={`${EYEBROW} text-risk`}>
              {scannedBlocking.length === 1
                ? "Blocking risk flag"
                : `${scannedBlocking.length} blocking risk flags`}
            </p>
            <div className="mt-2.5">
              <SafetyFindingList flags={scannedBlocking} size="md" />
            </div>
            {unsafeOG && (
              <p className="mt-3 border-t border-risk/20 pt-3 text-meta leading-relaxed text-fg-2">
                This is the oldest token with this name, but it carries blocking
                risk flags —{" "}
                <span className="font-semibold text-fg">
                  OGfinder is not calling it the OG.
                </span>
              </p>
            )}
          </div>
        )}

        {/* Unproven ordering, spelled out. A truncated history is a LOWER
            BOUND: true creation is at or before the date shown, by an unknown
            amount — so a token ranked below can still turn out to be older. */}
        {!preliminary && orderUnproven && (
          <div
            className="mt-4 rounded-xl border border-warn/30 bg-warn/[0.06] p-3.5 sm:p-4"
            title={UNPROVEN_ORDER_TITLE}
          >
            <p className={`${EYEBROW} text-warn`}>
              Age order not proven
              {unresolvedCount > 0 && (
                <span className="ml-1.5 font-mono normal-case tracking-normal">
                  · {unresolvedCount} unresolved
                </span>
              )}
            </p>
            <p className="mt-2 text-meta leading-relaxed text-fg-2">
              {unresolvedCount > 0 ? (
                <>
                  <span className="font-mono text-fg">{unresolvedCount}</span>{" "}
                  matching token{unresolvedCount === 1 ? "" : "s"} ha
                  {unresolvedCount === 1 ? "s" : "ve"} a transaction history too
                  deep to walk to the end, so the date shown for{" "}
                  {unresolvedCount === 1 ? "it" : "them"} is only an upper limit
                  — the real mint could be far older.
                </>
              ) : (
                <>
                  At least one matching token&rsquo;s history was too deep to
                  walk to the end, so its shown date is only an upper limit —
                  the real mint could be far older.
                </>
              )}{" "}
              <span className="font-semibold text-fg">
                {isOG
                  ? "#1 is the oldest we can currently prove, not a verified OG."
                  : "The #1 above is the oldest we can currently prove, not a verified OG."}
              </span>{" "}
              Scanning again resumes the deeper walk where it stopped.
            </p>
          </div>
        )}
      </div>

      {/* ── Identity ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-4 sm:px-6">
        {showLogo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={scanned!.imageUrl!}
            alt={name}
            width={36}
            height={36}
            loading="lazy"
            onError={() => setLogoFailed(true)}
            className="h-9 w-9 rounded-lg border object-cover"
          />
        )}
        <span className="font-display text-[15px] font-bold tracking-tight text-fg sm:text-base">
          {name}
        </span>
        {symbol && (
          <span className="font-mono text-meta text-fg-3">${symbol}</span>
        )}
        {scanned && (
          <SafetyChips
            level={scanned.safetyLevel}
            flags={scanned.safetyFlags}
            size="md"
          />
        )}
        {scanned && scanned.safetyLevel == null && (
          <RiskChips
            mintAuthorityActive={scanned.mintAuthorityActive}
            freezeAuthorityActive={scanned.freezeAuthorityActive}
            metadataMutable={scanned.metadataMutable}
            size="md"
          />
        )}
        {scanned?.topHolderPct != null && (
          <HolderConcChip pct={scanned.topHolderPct} size="md" />
        )}
        <span aria-hidden className="text-fg-4">
          ·
        </span>
        <span className="text-meta text-fg-3">
          minted{" "}
          {/* Bound-aware: a truncated walk reads "on or before <date>" here
              too, so the most prominent date on the page never asserts an
              exact creation we did not establish. */}
          <CreationDate
            createdAt={scanned?.createdAt ?? null}
            isLowerBound={scanned?.createdAtIsLowerBound === true}
            pending={scanned?.pendingAge === true}
          />
        </span>
        {ago && (
          <span
            className={`font-mono text-meta ${
              scanned?.createdAtIsLowerBound ? "text-warn/70" : "text-fg-4"
            }`}
          >
            {ago}
          </span>
        )}
        <span className="font-mono text-micro text-scan">
          {truncateMint(scannedMint)}
        </span>
        {scanned?.deployerAddress && (
          <span className="basis-full text-meta text-fg-3">
            <span className="text-fg-4">dev</span>{" "}
            <a
              href={`https://solscan.io/account/${scanned.deployerAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-micro text-scan hover:underline"
              title="Deployer wallet — fee payer of this mint's first transaction"
            >
              {truncateMint(scanned.deployerAddress)}
            </a>
            {scanned.deployerTokensCreated != null && (
              <>
                {" · "}
                {scanned.deployerTokensCreated >= SERIAL_DEPLOYER_MIN ? (
                  <span
                    className="font-semibold text-warn"
                    title="This wallet launches tokens in bulk — a common rug pattern"
                  >
                    ⚠️ serial deployer: {scanned.deployerTokensCreated}
                    {scanned.deployerTokensCreated >= TOKENS_CREATED_CAP
                      ? "+"
                      : ""}{" "}
                    tokens created
                  </span>
                ) : (
                  <span>
                    {scanned.deployerTokensCreated} token
                    {scanned.deployerTokensCreated === 1 ? "" : "s"} created
                  </span>
                )}
              </>
            )}
            {scanned.deployerWalletFirstSeenMs != null ? (
              <>
                {" · "}
                {Date.now() - scanned.deployerWalletFirstSeenMs <
                FRESH_WALLET_MS ? (
                  <span
                    className="font-semibold text-warn"
                    title="Deployer wallet is less than a week old"
                  >
                    ⚠️ fresh wallet
                  </span>
                ) : (
                  <span>
                    wallet since{" "}
                    {new Date(
                      scanned.deployerWalletFirstSeenMs
                    ).getUTCFullYear()}
                  </span>
                )}
              </>
            ) : scanned.deployerIsOldWallet ? (
              <>
                {" · "}
                <span title="Wallet history too deep to date — definitely not fresh">
                  established wallet
                </span>
              </>
            ) : null}
          </span>
        )}
        {scanned?.homoglyphSuspect && (
          <span
            className="basis-full text-meta font-semibold text-risk"
            title="Lookalike (Cyrillic/Greek) or invisible characters in the name — a common impersonation trick"
          >
            This token&rsquo;s name uses lookalike characters — likely
            impersonation
          </span>
        )}
        {scanned?.linkProvenance && (
          <span
            className="basis-full text-meta font-medium text-warn"
            title="Based on when OGfinder's link index first observed each claim — not when the link was created. The index only covers recently listed tokens."
          >
            Listed{" "}
            <span className="break-all font-mono text-micro">
              {scanned.linkProvenance.url}
            </span>{" "}
            — first seen by OGfinder{" "}
            {formatAgeGap(scanned.linkProvenance.leadMs)} before{" "}
            {scanned.linkProvenance.rivalCount} rival token
            {scanned.linkProvenance.rivalCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* ── Side-by-side vs the actual #1 — only once the verdict is final ── */}
      {!preliminary && !isOG && og && og.mint !== scannedMint && (
        <div className="border-t bg-bg/50 px-4 py-4 sm:px-6">
          <div className="grid gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch sm:gap-3">
            <div className="scan-ring rounded-xl border bg-scan/[0.05] px-3.5 py-3">
              <p className={`${EYEBROW} text-scan`}>Your token</p>
              <p className="mt-1.5 truncate font-display text-sm font-bold tracking-tight text-fg">
                {name}
                {symbol && (
                  <span className="ml-1.5 font-mono text-micro font-normal text-fg-3">
                    ${symbol}
                  </span>
                )}
              </p>
              <p className="mt-1 text-micro">
                <CreationDate
                  createdAt={scanned?.createdAt ?? null}
                  isLowerBound={scanned?.createdAtIsLowerBound === true}
                />
                {ago && (
                  <span
                    className={`font-mono ${
                      scanned?.createdAtIsLowerBound
                        ? "text-warn/70"
                        : "text-fg-4"
                    }`}
                  >
                    {" "}
                    · {ago}
                  </span>
                )}
              </p>
              {scanned?.safetyLevel && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <SafetyChips
                    level={scanned.safetyLevel}
                    flags={scanned.safetyFlags}
                    max={3}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-center px-1 text-center">
              <div>
                <p className={`${EYEBROW} text-fg-4`}>
                  {ogDanger || orderUnproven ? "Older by" : "OG is older by"}
                </p>
                <p
                  className="mt-1 font-display text-lg font-bold tracking-tight text-fg sm:text-xl"
                  title={
                    gapUnknown
                      ? "Both creation times are upper limits, so the gap between them is unknown."
                      : gapQualifier
                        ? "One of the two creation times is an upper limit, so this gap is a bound, not an exact difference."
                        : undefined
                  }
                >
                  {gapMs != null && gapMs > 0 && !gapUnknown ? (
                    <>
                      {gapQualifier && (
                        <span className="text-meta font-medium text-fg-3">
                          {gapQualifier}
                        </span>
                      )}
                      {formatAgeGap(gapMs)}
                    </>
                  ) : (
                    "—"
                  )}
                </p>
              </div>
            </div>

            {/* The #1 gets the gold panel only if IT is clean AND provably
                first — otherwise this strip would just move the endorsement one
                column over. */}
            <div
              className={`rounded-xl border px-3.5 py-3 ${
                ogDanger
                  ? "border-risk/35 bg-risk/[0.07]"
                  : orderUnproven
                    ? "border-warn/35 bg-warn/[0.06]"
                    : "og-glow bg-og/[0.06]"
              }`}
            >
              <p
                className={`${EYEBROW} ${
                  ogDanger
                    ? "text-risk"
                    : orderUnproven
                      ? "text-warn"
                      : "text-og"
                }`}
              >
                {ogDanger
                  ? "Oldest — #1 by age, unsafe"
                  : orderUnproven
                    ? "Oldest known — #1, not proven"
                    : "The OG — #1 by age"}
              </p>
              <p className="mt-1.5 truncate font-display text-sm font-bold tracking-tight text-fg">
                {og.displayName}
                <span className="ml-1.5 font-mono text-micro font-normal text-fg-3">
                  ${og.displaySymbol}
                </span>
              </p>
              <p className="mt-1 text-micro">
                <CreationDate
                  createdAt={og.createdAt}
                  isLowerBound={og.createdAtIsLowerBound === true}
                />
                {ogAgo && (
                  <span
                    className={`font-mono ${
                      og.createdAtIsLowerBound ? "text-warn/70" : "text-fg-4"
                    }`}
                  >
                    {" "}
                    · {ogAgo}
                  </span>
                )}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
                <SafetyChips
                  level={og.safetyLevel}
                  flags={og.safetyFlags}
                  max={3}
                />
                {og.topHolderPct != null && (
                  <HolderConcChip pct={og.topHolderPct} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-6">
        {canWatch && (
          <WatchButton
            query={watchQuery!.trim()}
            kind="mint-cluster"
            originMint={scannedMint}
          />
        )}
        <button
          type="button"
          onClick={shareVerdict}
          disabled={preliminary}
          title={
            preliminary
              ? "Verdict pending — verifying on-chain ages"
              : "Copy a shareable verdict link"
          }
          className={`ml-auto inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-meta font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 ${
            copied
              ? "border-up/40 bg-up/10 text-up"
              : copyFailed
                ? "border-down/40 bg-down/10 text-down"
                : endorsed && !preliminary
                  ? "border-og/35 bg-og/10 text-og hover:border-og/55 hover:bg-og/[0.16]"
                  : "bg-surface-2 text-fg-2 hover:border-line-str hover:text-fg"
          }`}
        >
          <span className="sr-only" role="status">
            {copied ? "Link copied" : copyFailed ? "Copy failed" : ""}
          </span>
          {copied ? "Link copied" : copyFailed ? "Copy failed" : "Share verdict"}
        </button>
      </div>
    </section>
  );
}
