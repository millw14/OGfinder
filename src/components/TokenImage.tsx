"use client";

import { useState } from "react";

/* ==========================================================================
   TokenImage — a token's picture, with the initial-letter block as its
   fallback. The single place that pattern lives (it was duplicated across
   TokenCard, ComparisonCard and ScanHero, each with its own failure flag).

   Every one of these images is ATTACKER-CONTROLLED content fetched from an
   arbitrary host named in the mint's metadata, so:
     - the caller always passes fixed h/w classes and we always object-cover,
       so a hostile aspect ratio (1×10000) cannot blow out the layout;
     - referrerPolicy="no-referrer" keeps the visitor's page URL off whatever
       host that is;
     - a load failure falls back to the letter block instead of leaving a
       broken-image glyph — and the failure is remembered PER SRC, so a
       results update that swaps in a different logo gets a fresh attempt.
   ========================================================================== */

export function TokenImage({
  src,
  alt,
  symbol,
  px,
  className = "",
  letterClassName = "",
}: {
  /** Validated http(s) URL from TokenResult.imageUrl, or nothing. */
  src?: string | null;
  alt: string;
  /** First character is the fallback glyph. */
  symbol?: string | null;
  /** Intrinsic size attributes — reserves the box before the image lands. */
  px: number;
  /** Size + shape + ring classes. Applied to the image AND the fallback, so
      the two occupy exactly the same space. */
  className?: string;
  /** Type scale for the fallback letter only. */
  letterClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const usable =
    typeof src === "string" && src.length > 0 && failedSrc !== src;

  if (usable) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={`shrink-0 object-cover ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-surface-2 font-display font-bold text-fg-4 ${letterClassName} ${className}`}
    >
      {symbol?.charAt(0)?.toUpperCase() || "?"}
    </span>
  );
}
