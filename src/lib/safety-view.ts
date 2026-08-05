import {
  flagFromCode,
  isKnownFlagCode,
  type SafetyFlag,
  type SafetyFlagCode,
  type SafetyLevel,
} from "./safety";

/**
 * Presentation-side derivations shared by every surface that renders a safety
 * verdict — token cards, the scan hero, the comparison card and the og:image.
 *
 * PURE and framework-free so the rules below are unit-testable and identical on
 * every surface:
 *  - Only `safetyLevel === "danger"` withholds the gold/crown treatment. The
 *    rank itself is never touched here.
 *  - An ABSENT level means the checks were never run for that token. It is not
 *    a finding and it is not a clean result — surfaces render nothing.
 *  - Codes are untrusted input (wire payloads, share URLs): unknown codes are
 *    dropped rather than rendered as blank chips.
 */

/**
 * Resolve flag codes to full flags, blocking-first, de-duplicated. Within each
 * tier the server's severity order is preserved, so `[0]` is the headline.
 */
export function orderSafetyFlags(
  codes?: readonly SafetyFlagCode[] | null
): SafetyFlag[] {
  if (!codes || codes.length === 0) return [];
  const seen = new Set<string>();
  const flags: SafetyFlag[] = [];
  for (const code of codes) {
    if (typeof code !== "string" || !isKnownFlagCode(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    flags.push(flagFromCode(code));
  }
  return [
    ...flags.filter((f) => f.tier === "blocking"),
    ...flags.filter((f) => f.tier === "caution"),
  ];
}

/** Blocking findings only — the ones that cost the endorsement. */
export function blockingFlags(
  codes?: readonly SafetyFlagCode[] | null
): SafetyFlag[] {
  return orderSafetyFlags(codes).filter((f) => f.tier === "blocking");
}

/**
 * The single finding that headlines a danger verdict — used where only one
 * mechanism fits (the share card band). null when nothing blocks.
 */
export function headlineBlockingFlag(
  codes?: readonly SafetyFlagCode[] | null
): SafetyFlag | null {
  return blockingFlags(codes)[0] ?? null;
}

/**
 * The one gate every gold surface keys off. Deliberately reads `safetyLevel`
 * rather than the confidence label, so the crown can never drift away from the
 * verdict that withheld it.
 */
export function isDangerous(level?: SafetyLevel | null): boolean {
  return level === "danger";
}
