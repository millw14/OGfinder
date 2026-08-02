/**
 * Head-to-head comparison mode ("mintA vs mintB").
 *
 * Comparisons are composed CLIENT-SIDE from two ordinary full /api/search
 * mint scans — there is no server-side compare mode, and the combined
 * input string is never sent to the API.
 */

import { isLikelyMintAddress } from "@/lib/solana";
import type { TokenResult } from "@/lib/types";

/** Separators: " vs " / " vs. " (any case), a comma, or plain whitespace. */
const SEPARATOR = /\s+vs\.?\s+|\s*,\s*|\s+/i;

/**
 * Parse a trimmed input as a two-mint comparison. Returns the two mints
 * only when the input splits into exactly two distinct likely mints.
 */
export function parseCompareInput(
  trimmed: string
): { a: string; b: string } | null {
  const parts = trimmed.split(SEPARATOR).filter(Boolean);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!isLikelyMintAddress(a) || !isLikelyMintAddress(b)) return null;
  if (a === b) return null;
  return { a, b };
}

/** One side of a comparison, composed from that mint's own full scan. */
export interface CompareSideState {
  mint: string;
  /** The scanned mint's pinned row from its own search results, when found. */
  token: TokenResult | null;
  /** Server verdict within this mint's OWN name search (not cross-comparable). */
  isScannedOG: boolean | null;
  scannedRank: number | null;
  totalFound: number | null;
  error: string | null;
}

export interface CompareState {
  a: CompareSideState;
  b: CompareSideState;
  loading: boolean;
}

export function emptyCompareSide(mint: string): CompareSideState {
  return {
    mint,
    token: null,
    isScannedOG: null,
    scannedRank: null,
    totalFound: null,
    error: null,
  };
}
