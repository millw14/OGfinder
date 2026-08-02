"use client";

import type { ReactNode } from "react";
import { LottieHover } from "./LottieHover";
import { bucketForToken, labelForBucket } from "@/lib/launchpads";
import crownOg from "@/assets/lottie/crown-og.json";

/* ==========================================================================
   Chip — the single primitive every pill in the app is built from.
   11px, rounded-full, ~10% tinted fill of the semantic colour, full-strength
   text and a matching hairline at ~25%. Tones map 1:1 to the design tokens.
   ========================================================================== */

export type ChipTone =
  | "og"
  | "scan"
  | "up"
  | "down"
  | "risk"
  | "warn"
  | "neutral"
  | "platform";

const CHIP_TONES: Record<ChipTone, string> = {
  og: "border-og/25 bg-og/10 text-og",
  scan: "border-scan/25 bg-scan/10 text-scan",
  up: "border-up/25 bg-up/10 text-up",
  down: "border-down/25 bg-down/10 text-down",
  risk: "border-risk/25 bg-risk/10 text-risk",
  warn: "border-warn/25 bg-warn/10 text-warn",
  neutral: "border-line bg-surface-3 text-fg-3",
  platform: "border-line bg-surface-3 text-fg-2",
};

const CHIP_SIZES: Record<"sm" | "md", string> = {
  sm: "gap-1 px-2 py-0.5 text-micro",
  md: "gap-1.5 px-2.5 py-1 text-micro",
};

export function Chip({
  tone = "neutral",
  size = "sm",
  className,
  title,
  children,
}: {
  tone?: ChipTone;
  size?: "sm" | "md";
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-medium ${
        CHIP_SIZES[size]
      } ${CHIP_TONES[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export function OGBadge({ rank }: { rank: number }) {
  if (rank !== 1) return null;
  return (
    <Chip
      tone="og"
      size="md"
      className="font-semibold uppercase tracking-[0.16em]"
    >
      <span className="og-badge-crown -ml-0.5 inline-flex shrink-0">
        <LottieHover animationData={crownOg} size={18} className="shrink-0" />
      </span>
      <span>OG</span>
    </Chip>
  );
}

/**
 * Stars = age-data quality (how reliable the creation time is), NOT OG-ness.
 * Drawn as five signal bars so it never reads as a star *rating* of the token.
 */
export function ConfidenceStars({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(5, score));
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      title={`Age data quality: ${clamped}/5 — how reliable this token's creation time is`}
    >
      <span className="sr-only">Age data quality {clamped} of 5</span>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-2.5 w-[3px] rounded-full ${
            i < clamped ? "bg-og" : "bg-surface-3"
          }`}
        />
      ))}
    </span>
  );
}

/** Neutral info chip for ranks 2+ whose name+symbol exactly match the query. */
export function ExactNameBadge() {
  return (
    <Chip
      tone="neutral"
      title="Name and symbol exactly match the search — says nothing about which token came first"
    >
      exact name
    </Chip>
  );
}

/**
 * Launchpad hues live on a 5px dot instead of the chip fill: the venue stays
 * identifiable at a glance without six extra colours competing with the verdict.
 */
const PLATFORM_DOTS: Record<string, string> = {
  pumpfun: "#f472b6",
  pumpswap: "#f472b6",
  raydium: "#a78bfa",
  launchlab: "#a78bfa",
  letsbonk: "#fb923c",
  moonshot: "#818cf8",
  boop: "#38bdf8",
  believe: "#4ade80",
  meteora: "#fb7185",
  orca: "#38bdf8",
  other: "#52525b",
};

export function PlatformBadge({
  dexId,
  mint,
}: {
  dexId: string | null;
  mint: string;
}) {
  const bucket = bucketForToken(dexId, mint);
  if (bucket === "unknown") return null;

  const label =
    bucket === "other"
      ? dexId
        ? dexId.charAt(0).toUpperCase() + dexId.slice(1)
        : "Other"
      : labelForBucket(bucket);

  return (
    <Chip tone="platform">
      <span
        aria-hidden
        className="h-[5px] w-[5px] shrink-0 rounded-full"
        style={{ backgroundColor: PLATFORM_DOTS[bucket] ?? "#52525b" }}
      />
      {label}
    </Chip>
  );
}

export function ScannedMintBadge() {
  return (
    <Chip
      tone="scan"
      className="font-semibold uppercase tracking-[0.14em]"
      title="The contract address you scanned"
    >
      Your CA
    </Chip>
  );
}

/**
 * Rug-risk chips from Helius DAS data. Chips render only when a risk is
 * explicitly PRESENT (true); undefined = unknown renders nothing — never a
 * false sense of safety. When all three are explicitly false, one emerald
 * "renounced" chip renders instead.
 */
export function RiskChips({
  mintAuthorityActive,
  freezeAuthorityActive,
  metadataMutable,
  size = "sm",
}: {
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  metadataMutable?: boolean;
  size?: "sm" | "md";
}) {
  const renounced =
    mintAuthorityActive === false &&
    freezeAuthorityActive === false &&
    metadataMutable === false;

  if (renounced) {
    return (
      <Chip
        tone="up"
        size={size}
        title="Mint & freeze revoked, metadata immutable"
      >
        renounced
      </Chip>
    );
  }

  const hasRisk =
    mintAuthorityActive === true ||
    freezeAuthorityActive === true ||
    metadataMutable === true;
  if (!hasRisk) return null;

  return (
    <>
      {mintAuthorityActive === true && (
        <Chip
          tone="risk"
          size={size}
          title="Mint authority active — supply can be inflated"
        >
          mint auth
        </Chip>
      )}
      {freezeAuthorityActive === true && (
        <Chip
          tone="risk"
          size={size}
          title="Freeze authority active — accounts can be frozen"
        >
          freeze
        </Chip>
      )}
      {metadataMutable === true && (
        <Chip
          tone="warn"
          size={size}
          title="Metadata is mutable — name/image can change"
        >
          mutable
        </Chip>
      )}
    </>
  );
}

/**
 * Top-10 token-account concentration for scanned/OG mints. Includes LP pools
 * and burn addresses, so the number is an UPPER BOUND on wallet concentration.
 */
export function HolderConcChip({
  pct,
  size = "sm",
}: {
  pct: number;
  size?: "sm" | "md";
}) {
  const tone: ChipTone = pct > 50 ? "risk" : pct > 25 ? "warn" : "neutral";

  const label =
    pct >= 10 ? String(Math.round(pct)) : pct >= 0.1 ? pct.toFixed(1) : "<0.1";

  return (
    <Chip
      tone={tone}
      size={size}
      title="Share of supply in the 10 largest token accounts. Includes liquidity pools and burn addresses, so treat as an upper bound."
    >
      top 10 accounts hold&nbsp;
      <span className="font-mono">{label}%</span>
    </Chip>
  );
}

/**
 * Emerald-outline chip: earliest indexed claimant of a contested social /
 * website link. Based on when OGfinder's index first OBSERVED each claim —
 * never on when the link was created.
 */
export function ProvenanceBadge() {
  return (
    <Chip
      tone="up"
      title="Based on when OGfinder's link index first observed each claim — not when the link was created. The index only covers recently listed tokens."
    >
      first link claim
    </Chip>
  );
}

/** Red warning chip: name matches the search only via lookalike folding. */
export function HomoglyphBadge() {
  return (
    <Chip
      tone="risk"
      className="font-semibold"
      title="Name uses lookalike/invisible characters — likely impersonation"
    >
      lookalike chars
    </Chip>
  );
}

export function BurnedBadge() {
  return (
    <Chip
      tone="neutral"
      title="On-chain supply is zero — this token has been fully burned"
    >
      Burned
    </Chip>
  );
}

/**
 * Rank rail marker above the token avatar. Rank 1 is the only gold surface in
 * the list; 2-3 sit on surface-3 and everything below fades back.
 */
export function RankBadge({ rank }: { rank: number }) {
  const base =
    "flex h-6 w-10 flex-shrink-0 items-center justify-center rounded-lg font-display text-[13px] font-bold tabular-nums";

  if (rank === 1) {
    return (
      <div
        className={`${base} bg-gradient-to-b from-og-light to-og text-black shadow-[0_0_16px_rgba(240,180,41,0.3)]`}
      >
        1
      </div>
    );
  }

  if (rank <= 3) {
    return (
      <div className={`${base} border bg-surface-3 text-fg-2`}>{rank}</div>
    );
  }

  return (
    <div className={`${base} border bg-surface-2 text-[12px] font-semibold text-fg-4`}>
      {rank}
    </div>
  );
}
