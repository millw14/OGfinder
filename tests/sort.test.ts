import { describe, it, expect } from "vitest";
import {
  ageDataQuality,
  isOgEndorsement,
  scoreConfidence,
  UNSAFE_RANK1_LABEL,
} from "@/lib/sort";
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

  it("strips the OG endorsement from a rank-1 with a blocking safety flag", () => {
    const honeypot = make({
      ...og,
      safetyLevel: "danger",
      safetyFlags: ["freeze-authority"],
    });
    const scored = scoreConfidence([honeypot, copycat], "bonk");
    // Rank stays factual — it IS the oldest.
    expect(scored[0].rank).toBe(1);
    expect(scored[0].mint).toBe(og.mint);
    // The endorsement does not.
    expect(scored[0].confidenceLabel).toBe(UNSAFE_RANK1_LABEL);
    expect(scored[0].confidenceLabel).toBe("Oldest — unsafe");
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
    expect(scored[0].rankLabel).toBe(UNSAFE_RANK1_LABEL);
  });

  it("keeps the crown for caution, clear, and unknown levels", () => {
    for (const level of ["caution", "clear", "unknown"] as const) {
      const scored = scoreConfidence(
        [make({ ...og, safetyLevel: level }), copycat],
        "bonk"
      );
      expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(true);
    }
  });

  it("an unassessed rank 1 still earns the crown (absent ≠ dangerous)", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[0].safetyLevel).toBeUndefined();
    expect(scored[0].confidenceLabel).toBe("OG");
  });

  it("uncertain age keeps precedence over the unsafe label", () => {
    // Either way it is not an endorsement; the age caveat is the more
    // fundamental one, so it wins the single label slot.
    const scored = scoreConfidence(
      [make({ ...og, createdAtIsLowerBound: true, safetyLevel: "danger" }), copycat],
      "bonk"
    );
    expect(scored[0].confidenceLabel).toBe("Oldest found");
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
  });

  it("leaves ranks 2+ unlabeled even when they are dangerous", () => {
    const scored = scoreConfidence(
      [og, make({ ...copycat, safetyLevel: "danger" })],
      "bonk"
    );
    expect(scored[1].confidenceLabel).toBe("");
    expect(scored[1].safetyLevel).toBe("danger");
  });

  it("carries safetyLevel and flags through a client-side re-score", () => {
    const scored = scoreConfidence(
      [
        make({
          ...og,
          safetyLevel: "danger",
          safetyFlags: ["transfer-hook", "mint-authority"],
        }),
        copycat,
      ],
      "bonk"
    );
    expect(scored[0].safetyFlags).toEqual(["transfer-hook", "mint-authority"]);
    // Re-scoring the output (what Results.tsx does) must be stable.
    const again = scoreConfidence(scored, "bonk");
    expect(again[0].confidenceLabel).toBe(UNSAFE_RANK1_LABEL);
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
