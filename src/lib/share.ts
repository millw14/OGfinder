/**
 * Compact verdict payload for shareable links (?v=<base64url>).
 *
 * Encoded client-side into share URLs and decoded server-side by
 * generateMetadata and /api/og. Decoding treats the input as fully
 * untrusted (it arrives from the URL): anything malformed returns null.
 * Dependency-free and isomorphic (btoa/atob in the browser, Buffer on
 * the server).
 */

export interface SharePayload {
  /** Token name */
  n: string;
  /** Token symbol */
  s: string;
  /** Created ISO date */
  d: string | null;
  /** Rank by age (1 = oldest) */
  r: number | null;
  /** Total results the rank is out of */
  t: number | null;
  /** Verdict: is this the OG */
  o: boolean;
  /** Mint address (scan mode), null for name search */
  m: string | null;
}

/** Hard cap on every string field, both encoding and decoding. */
const MAX_FIELD = 48;

function truncate(s: string): string {
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

/** UTF-8 string → base64url, in both browser and Node. */
function toBase64Url(json: string): string {
  let b64: string;
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(json, "utf8").toString("base64");
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → UTF-8 string, null on invalid input. */
function fromBase64Url(raw: string): string | null {
  const b64 =
    raw.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (raw.length % 4)) % 4);
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function encodeSharePayload(p: SharePayload): string {
  const compact: SharePayload = {
    n: truncate(p.n),
    s: truncate(p.s),
    d: p.d === null ? null : truncate(p.d),
    r: p.r,
    t: p.t,
    o: p.o,
    m: p.m === null ? null : truncate(p.m),
  };
  return toBase64Url(JSON.stringify(compact));
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/** Decode an untrusted ?v= param. Returns null on ANY malformed input. */
export function decodeSharePayload(raw: string): SharePayload | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return null;
  }
  const json = fromBase64Url(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  if (typeof p.n !== "string" || typeof p.s !== "string") return null;
  if (!isNullableString(p.d)) return null;
  if (!isNullableFiniteNumber(p.r)) return null;
  if (!isNullableFiniteNumber(p.t)) return null;
  if (typeof p.o !== "boolean") return null;
  if (!isNullableString(p.m)) return null;

  return {
    n: truncate(p.n),
    s: truncate(p.s),
    d: p.d === null ? null : truncate(p.d),
    r: p.r,
    t: p.t,
    o: p.o,
    m: p.m === null ? null : truncate(p.m),
  };
}

/** "2022-12-20T21:10:46.000Z" → "Dec 20, 2022" (UTC), null when unparsable. */
export function formatShareDate(d: string | null): string | null {
  if (!d) return null;
  const ms = Date.parse(d);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
