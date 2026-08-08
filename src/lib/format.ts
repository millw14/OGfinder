/** Shared client-side date formatting helpers. */

export function formatDate(isoStr: string | null): string {
  if (!isoStr) return "Unknown";
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Age gap between two creation times: "2y 3mo" / "8mo" / "12 days". */
export function formatAgeGap(gapMs: number): string {
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

/**
 * Wording for a creation time we only hold an UPPER LIMIT for. A truncated
 * signature walk proves "the token existed by this date" and nothing else —
 * the real mint is at or before it, by an unknown amount — so the date is
 * never rendered bare.
 */
export const LOWER_BOUND_PREFIX = "on or before";

/** Tooltip explaining why a date is a bound. Shared by every surface. */
export const LOWER_BOUND_TITLE =
  "This token's transaction history was too long to walk to the end, so this is only the oldest date we reached — the real creation is at or before it, by an unknown amount. Scanning again resumes the walk where it stopped.";

/** Tooltip for the unproven-order state (the #1 answer, not this token). */
export const UNPROVEN_ORDER_TITLE =
  "At least one matching token's transaction history was too long to walk to the end, so its shown date is only an upper limit — it could turn out to be older than the #1 above. The ranking is our best answer, not a proven one.";

/**
 * Creation date, bound-aware: "Dec 20, 2022" for a known date, "on or before
 * Dec 20, 2022" when the signature walk was truncated. Pure.
 */
export function formatCreatedAt(
  isoStr: string | null,
  isLowerBound?: boolean
): string {
  const date = formatDate(isoStr);
  // "Unknown" / "—" are already honest about knowing nothing — prefixing them
  // would read as a claim.
  if (!isLowerBound || !isoStr || date === "Unknown" || date === "—") {
    return date;
  }
  return `${LOWER_BOUND_PREFIX} ${date}`;
}

/**
 * Age, bound-aware: creation at or before T means the token is AT LEAST that
 * old, so the bound is the one direction we can state as a fact.
 */
export function formatAgeAgo(
  isoStr: string | null,
  isLowerBound?: boolean
): string {
  const ago = timeAgo(isoStr);
  if (!ago || !isLowerBound || ago === "unknown age") return ago;
  return `at least ${ago}`;
}

export function timeAgo(isoStr: string | null): string {
  if (!isoStr) return "";
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return "unknown age";
  const ms = Date.now() - date.getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (rem === 0) return `${years}y ago`;
  return `${years}y ${rem}mo ago`;
}
