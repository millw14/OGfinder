import { describe, it, expect } from "vitest";
import {
  deriveSearchTermsFromMintMetadata,
  deriveSearchTermFromMintMetadata,
} from "@/lib/mint-search";
import { mergeSearchCohorts } from "@/lib/scan";
import type { RawToken } from "@/lib/types";
import { MAX_HELIUS } from "@/lib/types";

describe("deriveSearchTermsFromMintMetadata", () => {
  it("searches the ticker too when it differs from the name", () => {
    // The reported regression: "Pepe Cosplay" trades as $CoPepe alongside the
    // older $COPEPE. Name-only search found nothing but itself → false OG.
    const terms = deriveSearchTermsFromMintMetadata("Pepe Cosplay", "CoPepe");
    expect(terms).toEqual(["Pepe Cosplay", "CoPepe"]);
  });

  it("keeps the name primary so scoring and display are unchanged", () => {
    expect(deriveSearchTermFromMintMetadata("Pepe Cosplay", "CoPepe")).toBe(
      "Pepe Cosplay"
    );
  });

  it("collapses to one term when name and symbol normalize the same", () => {
    expect(deriveSearchTermsFromMintMetadata("COPEPE", "COPEPE")).toEqual([
      "COPEPE",
    ]);
    // normalize() folds separators and case, so these are one search.
    expect(deriveSearchTermsFromMintMetadata("Bonk", "bonk")).toEqual(["Bonk"]);
    expect(deriveSearchTermsFromMintMetadata("dog-wif", "Dog Wif")).toEqual([
      "dog-wif",
    ]);
  });

  it("falls back to the symbol as primary when the name is too short", () => {
    const terms = deriveSearchTermsFromMintMetadata("X", "WIFHAT");
    expect(terms[0]).toBe("WIFHAT");
    // The sub-MIN_QUERY name is not searched on its own.
    expect(terms).toEqual(["WIFHAT"]);
  });

  it("strips invisible characters from both terms", () => {
    const terms = deriveSearchTermsFromMintMetadata(
      "Trump⁠Coin",
      "TRUMP​"
    );
    expect(terms).toEqual(["TrumpCoin", "TRUMP"]);
  });

  it("still returns a too-short leftover so the caller's guard reports it", () => {
    expect(deriveSearchTermsFromMintMetadata("X", "")).toEqual(["X"]);
    expect(deriveSearchTermsFromMintMetadata("", "")).toEqual([]);
  });
});

function tok(mint: string, over: Partial<RawToken> = {}): RawToken {
  return { mint, ...over };
}

describe("mergeSearchCohorts", () => {
  it("returns a single cohort untouched", () => {
    const one = [tok("a"), tok("b")];
    expect(mergeSearchCohorts([one])).toBe(one);
  });

  it("dedupes by mint, first occurrence winning", () => {
    const merged = mergeSearchCohorts([
      [tok("a", { dexName: "fromName" })],
      [tok("a", { dexName: "fromSymbol" }), tok("b")],
    ]);
    expect(merged.map((t) => t.mint)).toEqual(["a", "b"]);
    expect(merged[0].dexName).toBe("fromName");
  });

  it("backfills missing Jupiter metadata from the later cohort", () => {
    const merged = mergeSearchCohorts([
      [tok("a")],
      [tok("a", { jupName: "Alpha", jupSymbol: "ALPHA" })],
    ]);
    expect(merged[0].jupName).toBe("Alpha");
    expect(merged[0].jupSymbol).toBe("ALPHA");
  });

  it("interleaves so a long first cohort cannot starve the ticker cohort", () => {
    // Concatenate-then-slice would drop every symbol-cohort token here.
    const byName = Array.from({ length: MAX_HELIUS }, (_, i) =>
      tok(`name-${i}`)
    );
    const bySymbol = [tok("ticker-og"), tok("ticker-2")];
    const merged = mergeSearchCohorts([byName, bySymbol]);

    expect(merged.length).toBeLessThanOrEqual(MAX_HELIUS);
    expect(merged.map((t) => t.mint)).toContain("ticker-og");
    expect(merged.map((t) => t.mint)).toContain("ticker-2");
    // Round-robin: the ticker cohort lands early, not at the truncated tail.
    expect(merged.findIndex((t) => t.mint === "ticker-og")).toBeLessThan(4);
  });

  it("never exceeds the enrichment budget", () => {
    const a = Array.from({ length: MAX_HELIUS }, (_, i) => tok(`a-${i}`));
    const b = Array.from({ length: MAX_HELIUS }, (_, i) => tok(`b-${i}`));
    expect(mergeSearchCohorts([a, b]).length).toBe(MAX_HELIUS);
  });
});
