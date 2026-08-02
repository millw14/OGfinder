import { describe, it, expect } from "vitest";
import { ageDataQuality, scoreConfidence } from "@/lib/sort";
import type { TokenResult } from "@/lib/types";

/** Minimal TokenResult factory — only the fields the scorers read. */
function make(partial: Partial<TokenResult>): TokenResult {
  return {
    mint: "Mint11111111111111111111111111111111111111",
    displayName: "Token",
    displaySymbol: "TKN",
    slot: null,
    createdAtMs: null,
    createdAt: null,
    dexId: null,
    confidence: 0,
    confidenceLabel: "",
    rank: 0,
    rankLabel: "",
    timeSource: null,
    volumeUsd24h: null,
    marketCapUsd: null,
    fdvUsd: null,
    ...partial,
  } as TokenResult;
}

const YEAR = 365 * 24 * 3600 * 1000;

describe("ageDataQuality", () => {
  it("tiers by time source", () => {
    expect(ageDataQuality(make({ createdAtMs: 1, timeSource: "helius" }))).toBe(5);
    expect(
      ageDataQuality(make({ createdAtMs: 1, timeSource: "signatures" }))
    ).toBe(4);
    expect(
      ageDataQuality(make({ createdAtMs: 1, timeSource: "dexscreener" }))
    ).toBe(3);
  });

  it("caps at 3 for lower-bound creation times", () => {
    expect(
      ageDataQuality(
        make({
          createdAtMs: 1,
          timeSource: "signatures",
          createdAtIsLowerBound: true,
        })
      )
    ).toBe(3);
  });

  it("returns 1 for pending or missing age", () => {
    expect(ageDataQuality(make({ pendingAge: true, createdAtMs: 1 }))).toBe(1);
    expect(ageDataQuality(make({ createdAtMs: null }))).toBe(1);
  });
});

describe("scoreConfidence", () => {
  const og = make({
    mint: "OGmint111111111111111111111111111111111111",
    displayName: "Bonk",
    displaySymbol: "Bonk",
    createdAtMs: Date.parse("2022-12-20T00:00:00Z"),
    timeSource: "signatures",
  });
  const copycat = make({
    mint: "Copy1111111111111111111111111111111111111",
    displayName: "Bonk",
    displaySymbol: "Bonk",
    createdAtMs: Date.parse("2022-12-20T00:00:00Z") + 3 * YEAR,
    timeSource: "dexscreener",
  });

  it("awards the strong OG label only to rank 1 with exact match, gap, and stars>=4", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("OG");
    expect(scored[0].rank).toBe(1);
  });

  it("never puts OG-flavored labels on ranks 2+", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[1].confidenceLabel).toBe("");
    expect(scored[1].rank).toBe(2);
  });

  it("downgrades rank 1 to Likely OG when age data is pair-time only", () => {
    const weakOg = make({
      ...og,
      timeSource: "dexscreener",
    });
    const scored = scoreConfidence([weakOg, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Likely OG");
  });

  it("demotes a homoglyph-suspect rank 1 to Oldest found", () => {
    const fake = make({ ...og, homoglyphSuspect: true });
    const scored = scoreConfidence([fake, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Oldest found");
  });

  it("labels lower-bound rank 1 as Oldest found", () => {
    const uncertain = make({ ...og, createdAtIsLowerBound: true });
    const scored = scoreConfidence([uncertain, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Oldest found");
  });

  it("sets exactMatch only when name AND symbol both match", () => {
    const nameOnly = make({
      ...copycat,
      displayName: "bonk",
      displaySymbol: "OTHER",
    });
    const scored = scoreConfidence([og, nameOnly], "bonk");
    expect(scored[0].exactMatch).toBe(true);
    expect(scored[1].exactMatch).toBeUndefined();
  });
});
