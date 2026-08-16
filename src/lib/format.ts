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

/**
 * Tooltip for a derivative-name result. Shared by the card chip and the list
 * divider so both explain the same thing in the same words.
 */
export const RELATED_NAME_TITLE =
  "This token's name only contains the search term inside a longer word (like BONKMONEY for “bonk”), so it is not competing for the name — it is listed for interest and can never be ranked as the OG, however old it is.";

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

/**
 * Trim a scaled number to at most 2 significant decimals, dropping the zeros a
 * fixed precision leaves behind ("1.00" → "1", "1.20" → "1.2").
 */
function trimScaled(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(dp).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

/** Magnitude suffixes, largest first. Token supplies reach into the trillions. */
const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e15, "Q"],
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * Compact number for display: "88T", "1B", "12.5M", "1.2K". Pure.
 * Non-finite input renders as "—" rather than "NaN".
 */
export function formatCompactNumber(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  for (const [scale, suffix] of COMPACT_UNITS) {
    if (abs >= scale) return `${trimScaled(n / scale)}${suffix}`;
  }
  return trimScaled(n);
}

/**
 * On-chain supply as a human number.
 *
 * `raw` is DAS token_info.supply — BASE UNITS, so it only means anything once
 * divided by 10**decimals (BONK's raw 8.8e18 is really ~88T tokens). Without a
 * usable `decimals` we return NULL and the caller renders nothing: a supply
 * that is wrong by five orders of magnitude is worse than no supply at all.
 */
export function formatTokenSupply(
  raw: number | null | undefined,
  decimals: number | null | undefined
): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 32
  ) {
    return null;
  }
  return formatCompactNumber(raw / 10 ** decimals);
}

/** Hosts whose FIRST path segment is the account handle. */
const HANDLE_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "t.me",
  "telegram.me",
  "telegram.dog",
]);

/**
 * First-path segments on those hosts that are SITE FEATURES, not accounts.
 * Seen live: a token whose "twitter" link is x.com/search?q=<name> — labelling
 * that "@search" would invent an account the project does not have.
 */
const NON_HANDLE_SEGMENTS = new Set([
  "search",
  "i",
  "intent",
  "hashtag",
  "home",
  "explore",
  "share",
  "compose",
  "messages",
  "notifications",
  "settings",
  "login",
  "signup",
]);

const MAX_SOCIAL_LABEL = 28;

function clampLabel(s: string): string {
  return s.length <= MAX_SOCIAL_LABEL
    ? s
    : `${s.slice(0, MAX_SOCIAL_LABEL - 1)}…`;
}

/**
 * Percent-decode a path segment so the filter below sees real characters. A
 * bidi override arrives as "%E2%80%AE", and filtering BEFORE decoding would
 * leave the literal "E280AE" sitting in the label. Malformed escapes keep the
 * raw segment — the filter still runs over it either way.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Human label for a link a TOKEN CLAIMS as its own: "@handle" for X/Telegram,
 * otherwise the bare host.
 *
 * Never the raw URL. These strings come from attacker-controlled metadata, so
 * a long one would blow out the row, and a path rendered in full invites being
 * read as a claim we checked. The handle is filtered down to [A-Za-z0-9._-] so
 * no bidi override or invisible character can reach the label, and `hostname`
 * stays punycode for IDNs, which keeps lookalike domains visibly encoded.
 *
 * Returns null when the value is not an http(s) URL we can label. Pure.
 */
export function formatSocialLabel(url: unknown): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const segment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  if (
    HANDLE_HOSTS.has(host) &&
    segment &&
    !NON_HANDLE_SEGMENTS.has(segment.toLowerCase())
  ) {
    const handle = decodeSegment(segment)
      .replace(/[^A-Za-z0-9._-]/g, "")
      .replace(/^\.+/, "");
    if (handle) return clampLabel(`@${handle}`);
  }
  return clampLabel(host);
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
