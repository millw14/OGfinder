"use client";

import type { ReactNode } from "react";

/* ==========================================================================
   Chip — the single primitive every pill in the app is built from.
   11px, rounded-full, ~10% tinted fill of the semantic colour, full-strength
   text and a matching hairline at ~25%. Tones map 1:1 to the design tokens.

   Lives in its own module (rather than inside Badge.tsx) so surfaces that only
   need a pill — BotCta's sample reply, for one — don't drag lottie-react and
   the crown animation into their bundle. Badge.tsx re-exports it, so every
   existing `import { Chip } from "./Badge"` keeps working.
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
  neutral: "bg-surface-3 text-fg-3",
  platform: "bg-surface-3 text-fg-2",
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
