/** Detect http(s) URL or bare domain paths for social / website link search. */
export function isLikelySocialUrl(s: string): boolean {
  const t = s.trim();
  if (t.length < 8) return false;
  if (/^https?:\/\//i.test(t)) return true;
  // bare domain e.g. x.com/foo, t.me/bar
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(t)) return true;
  return false;
}

/** Canonical string for comparing DexScreener website/social URLs. */
export function normalizeForSocialMatch(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProto);
    let host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "twitter.com") host = "x.com";
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    // Dex often lists /communities/… without the /i/ segment.
    if (host === "x.com") {
      path = path.replace(/^\/i\/communities\//, "/communities/");
    }
    // Strip query string params (e.g. ?s=20) for cleaner matching.
    return `${host}${path}`;
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .toLowerCase();
  }
}

/**
 * Build all target strings to match against DexScreener social/website URLs.
 * For tweet URLs this includes the profile-level target (x.com/handle),
 * so tokens listing the handle's profile will match even if the user
 * pasted a specific tweet.
 */
export function socialMatchTargets(inputUrl: string): string[] {
  const primary = normalizeForSocialMatch(inputUrl);
  if (!primary) return [];
  const targets = [primary];
  try {
    const withProto = /^https?:\/\//i.test(inputUrl.trim())
      ? inputUrl.trim()
      : `https://${inputUrl.trim()}`;
    const u = new URL(withProto);
    let host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "twitter.com") host = "x.com";
    const parts = u.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase());

    if (host === "x.com" || host === "twitter.com") {
      // Tweet URL → also match profile: x.com/handle
      const statusIdx = parts.findIndex(
        (p, i) => i > 0 && p === "status"
      );
      if (statusIdx > 0) {
        const handle = parts[statusIdx - 1];
        targets.push(`x.com/${handle}`);
        targets.push(`twitter.com/${handle}`);
      }
      // Profile URL without /i/ → also match with /i/
      const commIdx = parts.indexOf("communities");
      if (commIdx >= 0 && commIdx + 1 < parts.length) {
        const id = parts[commIdx + 1];
        targets.push(`x.com/communities/${id}`);
        targets.push(`x.com/i/communities/${id}`);
      }
      // First non-reserved path segment as handle (statusIdx is -1 when absent)
      if (statusIdx < 0 && parts.length >= 1) {
        const first = parts[0];
        if (looksLikeXHandle(first)) {
          targets.push(`x.com/${first}`);
          targets.push(`twitter.com/${first}`);
        }
      }
    }
  } catch {
    /* keep primary only */
  }
  return Array.from(new Set(targets));
}

function hostLabelPrefixes(hostname: string): string[] {
  const label = hostname.split(".")[0]?.toLowerCase() ?? "";
  if (label.length < 4) return [];
  const out: string[] = [];
  for (let len = 4; len <= Math.min(12, label.length); len++) {
    out.push(label.slice(0, len));
  }
  return out;
}

const RESERVED_X_SEGMENTS = new Set([
  "i",
  "status",
  "communities",
  "intent",
  "search",
  "home",
  "hashtag",
  "explore",
  "notifications",
  "messages",
  "settings",
  "compose",
]);

function looksLikeXHandle(seg: string): boolean {
  return (
    /^[a-z0-9_]{3,15}$/i.test(seg) &&
    !RESERVED_X_SEGMENTS.has(seg.toLowerCase())
  );
}

function addNumericSuffixTerms(seg: string, out: string[]): void {
  if (!/^\d{8,}$/.test(seg)) return;
  if (seg.length >= 8) out.push(seg.slice(-8));
  if (seg.length >= 12) out.push(seg.slice(-12));
}

/**
 * Generate DexScreener search terms ordered by likely usefulness.
 * High-signal terms (handle, host label prefix) come first; generic terms
 * (e.g. "twitter") go last so they don't crowd out candidates.
 */
export function searchTermsForDex(input: string): string[] {
  const high: string[] = [];
  const medium: string[] = [];
  const low: string[] = [];
  const trimmed = input.trim();

  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProto);
    const parts = u.pathname.split("/").filter(Boolean);
    const host = u.hostname.replace(/^www\./i, "");
    const hostLower = host.toLowerCase();
    const isTwitterHost =
      hostLower === "x.com" || hostLower === "twitter.com";

    if (isTwitterHost) {
      const statusIdx = parts.findIndex(
        (p, i) => i > 0 && p.toLowerCase() === "status"
      );
      if (statusIdx > 0) {
        const handle = parts[statusIdx - 1];
        if (looksLikeXHandle(handle)) high.push(handle);
      }
      for (const p of parts) {
        if (looksLikeXHandle(p)) high.push(p);
      }
      const last = parts[parts.length - 1];
      if (last) addNumericSuffixTerms(last, low);
      low.push("twitter");
      low.push("twitter.com");
    } else {
      high.push(...hostLabelPrefixes(hostLower));
      if (hostLower.length >= 3) medium.push(hostLower);
      const hostNoWww = hostLower.replace(/^www\./, "");
      if (hostNoWww !== hostLower) medium.push(hostNoWww);
    }

    for (const p of parts) {
      if (
        p.length >= 3 &&
        p !== "www" &&
        !RESERVED_X_SEGMENTS.has(p.toLowerCase()) &&
        !/^\d+$/.test(p)
      ) {
        medium.push(p);
      }
    }

    low.push(`${host}${u.pathname}`.replace(/\/$/, ""));
    low.push(trimmed.replace(/^https?:\/\//i, ""));
  } catch {
    high.push(trimmed);
  }

  const all = [...high, ...medium, ...low];
  return Array.from(
    new Set(all.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))
  ).slice(0, 16);
}

/** Path-prefix URL match: exact, or one extends the other at a `/` boundary. */
function urlNormPathPrefixMatch(stored: string, target: string): boolean {
  if (stored === target) return true;
  if (
    stored.startsWith(target) &&
    stored.length > target.length &&
    stored[target.length] === "/"
  ) {
    return true;
  }
  if (
    target.startsWith(stored) &&
    target.length > stored.length &&
    target[stored.length] === "/" &&
    stored.includes("/")
  ) {
    return true;
  }
  return false;
}

/** Check if a stored link URL matches ANY of the target variants. */
export function linkMatchesTarget(
  linkUrl: string,
  targetNorms: string[]
): boolean {
  const n = normalizeForSocialMatch(linkUrl);
  if (!n) return false;
  for (const t of targetNorms) {
    if (!t) continue;
    if (urlNormPathPrefixMatch(n, t)) return true;
  }
  return false;
}

/**
 * Keywords for Birdeye /defi/v3/search: X handle or website host label.
 */
export function birdeyeSearchKeywords(inputUrl: string): string[] {
  const trimmed = inputUrl.trim();
  try {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProto);
    let host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "twitter.com") host = "x.com";
    const parts = u.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase());

    if (host === "x.com") {
      if (parts.includes("communities")) return [];
      const statusIdx = parts.findIndex((p, i) => i > 0 && p === "status");
      if (statusIdx > 0) {
        const h = parts[statusIdx - 1];
        if (looksLikeXHandle(h)) return [h];
      }
      for (const p of parts) {
        if (looksLikeXHandle(p)) return [p];
      }
      return [];
    }

    const label = host.split(".")[0] ?? "";
    if (label.length >= 3) return [label];
  } catch {
    /* ignore */
  }
  return [];
}
