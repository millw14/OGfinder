"use client";

import { LottieHover } from "./LottieHover";
import { bucketForToken, labelForBucket } from "@/lib/launchpads";
import { Chip, type ChipTone } from "./Chip";
import { orderSafetyFlags } from "@/lib/safety-view";
import {
  formatAgeAgo,
  formatCreatedAt,
  LOWER_BOUND_TITLE,
  RELATED_NAME_TITLE,
  UNPROVEN_ORDER_TITLE,
} from "@/lib/format";
import type { SafetyFlag, SafetyFlagCode, SafetyLevel } from "@/lib/safety";
import crownOg from "@/assets/lottie/crown-og.json";

/* The chip primitive now lives in ./Chip so pill-only surfaces don't pull in
   lottie-react. Re-exported here: every existing import site is unchanged. */
export { Chip };
export type { ChipTone };

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

/**
 * A token's creation time, rendered so it can never overstate what we know.
 *
 * A truncated signature walk yields a LOWER BOUND — "created at or before this
 * date, by an unknown amount" — which is exactly the fact the reported
 * regression threw away. So a bounded date renders as "on or before <date>"
 * (never bare) and its age as "at least <n> ago", both in warn amber with the
 * explanation on hover. Unbounded dates render exactly as before.
 */
export function CreationDate({
  createdAt,
  isLowerBound = false,
  pending = false,
  showAgo = false,
  className = "",
}: {
  createdAt: string | null;
  isLowerBound?: boolean;
  pending?: boolean;
  /** Also render the relative age ("2y 3mo ago") beside the date. */
  showAgo?: boolean;
  /** Classes for the date itself (the age always sits one step quieter). */
  className?: string;
}) {
  if (pending) {
    return (
      <span
        className="animate-pulse font-medium text-fg-4"
        title="On-chain age check in progress"
      >
        dating…
      </span>
    );
  }
  const ago = showAgo ? formatAgeAgo(createdAt, isLowerBound) : "";
  return (
    <>
      <span
        className={`font-mono ${
          isLowerBound ? "text-warn" : className || "text-fg-2"
        }`}
        title={isLowerBound ? LOWER_BOUND_TITLE : undefined}
      >
        {formatCreatedAt(createdAt, isLowerBound)}
      </span>
      {ago && (
        <span
          className={`font-mono ${isLowerBound ? "text-warn/70" : "text-fg-4"}`}
          title={isLowerBound ? LOWER_BOUND_TITLE : undefined}
        >
          {ago}
        </span>
      )}
    </>
  );
}

/**
 * Rank-1 marker for a creation ranking whose ORDER is not proven: a token
 * ranked below still carries a lower-bound age that could predate it. Neutral
 * amber, never gold — it stands exactly where the OG crown would have.
 */
export function UnprovenOrderBadge({ count }: { count?: number | null }) {
  return (
    <Chip
      tone="warn"
      size="md"
      className="font-semibold uppercase tracking-[0.14em]"
      title={UNPROVEN_ORDER_TITLE}
    >
      oldest known
      {count != null && count > 0 ? (
        <span className="font-mono normal-case tracking-normal">
          · {count} unresolved
        </span>
      ) : (
        <span className="normal-case tracking-normal">· not proven</span>
      )}
    </Chip>
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

const CLEAR_TITLE =
  "The blocking checks (transfer restrictions, freeze/seize powers, 24h sells) ran and found nothing. That is an absence of findings — not a guarantee that this token is safe.";
const UNKNOWN_TITLE =
  "We could not complete the safety checks for this token (RPC or market data unavailable), so nothing is known either way.";

/**
 * The safety verdict as pills. THE ONLY COLOURS HERE ARE RED AND AMBER.
 *
 *  - blocking findings → risk red, first
 *  - caution findings  → warn amber
 *  - "clear"           → one NEUTRAL "no blocking flags found" — never green,
 *                        never the word safe: it is an absence of findings
 *  - "unknown"         → one muted "safety checks unavailable"
 *  - no level at all   → NOTHING. The checks were not run for this token, and
 *                        silence is the only honest rendering of that.
 *
 * Every chip carries its mechanism-and-consequence sentence as the tooltip.
 */
export function SafetyChips({
  level,
  flags,
  size = "sm",
  max,
}: {
  level?: SafetyLevel;
  flags?: SafetyFlagCode[];
  size?: "sm" | "md";
  /** Cap the chips rendered; the overflow collapses into one "+N more". */
  max?: number;
}) {
  if (!level) return null;

  if (level === "unknown") {
    return (
      <Chip tone="muted" size={size} title={UNKNOWN_TITLE}>
        safety checks unavailable
      </Chip>
    );
  }

  const ordered = orderSafetyFlags(flags);

  if (ordered.length === 0) {
    if (level === "clear") {
      return (
        <Chip tone="neutral" size={size} title={CLEAR_TITLE}>
          no blocking flags found
        </Chip>
      );
    }
    return null;
  }

  const shown = max != null && max > 0 ? ordered.slice(0, max) : ordered;
  const overflow = ordered.slice(shown.length);

  return (
    <>
      {shown.map((f) => (
        <Chip
          key={f.code}
          tone={f.tier === "blocking" ? "risk" : "warn"}
          size={size}
          title={f.detail}
          className={f.tier === "blocking" ? "font-semibold" : undefined}
        >
          {f.label}
        </Chip>
      ))}
      {overflow.length > 0 && (
        <Chip
          tone="neutral"
          size={size}
          title={overflow.map((f) => `${f.label} — ${f.detail}`).join("\n")}
        >
          +{overflow.length} more
        </Chip>
      )}
    </>
  );
}

/**
 * Findings spelled out — mechanism AND consequence, one line each. Used where
 * a chip's tooltip isn't enough: the danger strip on a card and the unsafe
 * verdict hero, both of which a user reads before deciding to buy.
 */
export function SafetyFindingList({
  flags,
  size = "sm",
}: {
  flags: SafetyFlag[];
  size?: "sm" | "md";
}) {
  if (flags.length === 0) return null;
  return (
    <ul
      className={`space-y-1.5 ${size === "md" ? "text-meta" : "text-micro"}`}
    >
      {flags.map((f) => (
        <li key={f.code} className="flex gap-2 leading-relaxed">
          <span
            aria-hidden
            className={`mt-[0.45em] h-1 w-1 shrink-0 rounded-full ${
              f.tier === "blocking" ? "bg-risk" : "bg-warn"
            }`}
          />
          <span>
            <span
              className={`font-semibold ${
                f.tier === "blocking" ? "text-risk" : "text-warn"
              }`}
            >
              {f.label}
            </span>
            <span className="text-fg-3"> — {f.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Rug-risk chips from Helius DAS data, for tokens the safety engine did NOT
 * assess (ranks 2+ in a list — see SafetyChips for assessed tokens). Chips
 * render only when a risk is explicitly PRESENT (true); undefined = unknown
 * renders nothing.
 *
 * When all three are explicitly false, one NEUTRAL factual chip renders. It is
 * deliberately not green and deliberately not the word "safe": three revoked
 * authorities say nothing about transfer hooks, permanent delegates or whether
 * anyone has managed to sell.
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
        tone="neutral"
        size={size}
        title="Mint and freeze authorities are revoked and metadata is immutable. Those three checks only — nothing here covers transfer restrictions or whether sells go through."
      >
        authorities revoked
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

/**
 * Quietest chip in the set: this token's name merely CONTAINS the search term
 * inside a longer word. It is listed because it is interesting, never because
 * it is a contender — so it gets the "we're just showing you this" tone, never
 * gold, and says why on hover.
 */
export function RelatedNameBadge() {
  return (
    <Chip tone="muted" title={RELATED_NAME_TITLE}>
      related name
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
 *
 * `muted` and `unproven` both keep the NUMBER (rank stays factual — this token
 * really is the oldest we could date) while dropping the gold, which is
 * endorsement styling that neither a token with blocking flags nor an
 * unprovable ordering has earned. `muted` wins when both apply: a blocking
 * flag is the more urgent thing to see.
 *
 * `related` marks a derivative name, which is not in the running at all: it
 * keeps its number in the single 1..N sequence and takes the quietest surface
 * at every rank, so the tail of the list reads as a different kind of result
 * rather than a continuation of the leaderboard.
 */
export function RankBadge({
  rank,
  muted = false,
  unproven = false,
  related = false,
}: {
  rank: number;
  muted?: boolean;
  /** Rank 1 of an ordering that a lower-bound token below could still overturn. */
  unproven?: boolean;
  /** Derivative name — listed for interest, never a contender for the name. */
  related?: boolean;
}) {
  const base =
    "flex h-6 w-10 flex-shrink-0 items-center justify-center rounded-lg font-display text-[13px] font-bold tabular-nums";

  // Checked before every rank-gated treatment below, including the gold one:
  // a derivative name must never pick up endorsement styling, whatever number
  // it happens to carry.
  if (related) {
    return (
      <div
        className={`${base} border bg-surface-2 text-[12px] font-semibold text-fg-4`}
        title={RELATED_NAME_TITLE}
      >
        {rank}
      </div>
    );
  }

  if (rank === 1 && muted) {
    return (
      <div className={`${base} border border-risk/35 bg-risk/[0.12] text-risk`}>
        1
      </div>
    );
  }

  if (rank === 1 && unproven) {
    return (
      <div
        className={`${base} border border-warn/35 bg-warn/[0.10] text-warn`}
        title={UNPROVEN_ORDER_TITLE}
      >
        1
      </div>
    );
  }

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
