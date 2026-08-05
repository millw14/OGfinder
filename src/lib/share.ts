/**
 * Compact verdict payload for shareable links (?v=<base64url>).
 *
 * Encoded client-side into share URLs and decoded server-side by
 * generateMetadata and /api/og. Decoding treats the input as fully
 * untrusted (it arrives from the URL): anything malformed returns null.
 * Isomorphic (btoa/atob in the browser, Buffer on the server) and free of
 * runtime dependencies beyond the pure safety-flag vocabulary.
 */

import {
  isBlockingCode,
  isKnownFlagCode,
  type SafetyFlagCode,
} from "./safety";

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

// ————— Safety marker (?sf=) — sibling of ?v=, never part of it —————

/**
 * A shared verdict link can carry ONE safety marker: the headline blocking
 * flag code of the token the card is about (`?sf=freeze-authority`).
 *
 * It rides beside ?v= rather than inside the payload on purpose — the ?v=
 * decoder is strict and its contract is frozen, so every link minted before
 * this existed keeps decoding and rendering byte-identically.
 *
 * Only BLOCKING codes are accepted: the marker exists to replace an
 * endorsement with a named mechanism, and a caution finding does not earn a
 * red band. Anything else decodes to null, i.e. "no marker".
 */

/** Raw ?sf= length cap — the longest real code is well under this. */
const MAX_SAFETY_MARKER = 32;

/** Serialize a blocking flag code for a ?sf= param (opaque to callers). */
export function encodeSafetyMarker(code: SafetyFlagCode): string {
  return code;
}

/** Decode an untrusted ?sf= param. Returns null on ANY non-blocking input. */
export function decodeSafetyMarker(
  raw: string | null | undefined
): SafetyFlagCode | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > MAX_SAFETY_MARKER) return null;
  if (!isKnownFlagCode(raw)) return null;
  if (!isBlockingCode(raw)) return null;
  return raw;
}

// ————— Comparison share payloads (?cv=) — sibling of ?v=, never replaces it —————

/** One side of a shared head-to-head comparison. */
export interface CompareShareSide {
  /** Token name */
  n: string;
  /** Token symbol */
  s: string;
  /** Created date, sliced to YYYY-MM-DD */
  d: string | null;
  /** Mint address */
  m: string;
}

export interface ComparePayload {
  a: CompareShareSide;
  b: CompareShareSide;
  /** Winner (older side): 0 = a, 1 = b, null = no verdict */
  w: 0 | 1 | null;
}

/** Name/symbol cap for compare payloads (two tokens must fit one card). */
const MAX_COMPARE_NAME = 24;
/** Created-date cap: "YYYY-MM-DD". */
const MAX_COMPARE_DATE = 10;
/** Raw ?cv= length cap (two sides, so larger than the 512 ?v= cap). */
const MAX_COMPARE_RAW = 768;

function compactCompareSide(s: CompareShareSide): CompareShareSide {
  return {
    n: s.n.slice(0, MAX_COMPARE_NAME),
    s: s.s.slice(0, MAX_COMPARE_NAME),
    d: s.d === null ? null : s.d.slice(0, MAX_COMPARE_DATE),
    m: truncate(s.m),
  };
}

export function encodeComparePayload(p: ComparePayload): string {
  const compact: ComparePayload = {
    a: compactCompareSide(p.a),
    b: compactCompareSide(p.b),
    w: p.w,
  };
  return toBase64Url(JSON.stringify(compact));
}

function decodeCompareSide(v: unknown): CompareShareSide | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.n !== "string" || typeof s.s !== "string") return null;
  if (!isNullableString(s.d)) return null;
  if (typeof s.m !== "string") return null;
  return compactCompareSide({ n: s.n, s: s.s, d: s.d, m: s.m });
}

/** Decode an untrusted ?cv= param. Returns null on ANY malformed input. */
export function decodeComparePayload(raw: string): ComparePayload | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_COMPARE_RAW
  ) {
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

  const a = decodeCompareSide(p.a);
  const b = decodeCompareSide(p.b);
  if (a === null || b === null) return null;
  if (p.w !== 0 && p.w !== 1 && p.w !== null) return null;

  return { a, b, w: p.w };
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
