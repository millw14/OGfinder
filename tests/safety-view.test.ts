import { describe, it, expect } from "vitest";
import {
  orderSafetyFlags,
  blockingFlags,
  headlineBlockingFlag,
  isDangerous,
} from "@/lib/safety-view";
import type { SafetyFlagCode } from "@/lib/safety";

/**
 * These are the rules every safety surface (cards, hero, comparison, og:image)
 * renders through, so they are pinned here rather than re-derived per component.
 */
describe("orderSafetyFlags", () => {
  it("returns blocking findings before caution findings", () => {
    const flags = orderSafetyFlags([
      "mutable-metadata",
      "freeze-authority",
      "mint-authority",
      "transfer-hook",
    ]);
    expect(flags.map((f) => f.code)).toEqual([
      "freeze-authority",
      "transfer-hook",
      "mutable-metadata",
      "mint-authority",
    ]);
    expect(flags.slice(0, 2).every((f) => f.tier === "blocking")).toBe(true);
  });

  it("preserves the server's order within a tier", () => {
    const flags = orderSafetyFlags(["no-sells", "permanent-delegate"]);
    expect(flags.map((f) => f.code)).toEqual(["no-sells", "permanent-delegate"]);
  });

  it("resolves every code to a label and a mechanism sentence", () => {
    for (const f of orderSafetyFlags(["freeze-authority", "low-liquidity"])) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.detail.length).toBeGreaterThan(0);
    }
  });

  it("drops unknown codes instead of rendering blank chips", () => {
    // Codes arrive over the wire and out of URLs — an old client, a renamed
    // code, or a hand-edited payload must not produce an empty red pill.
    const flags = orderSafetyFlags([
      "not-a-real-code",
      "freeze-authority",
      "",
    ] as unknown as SafetyFlagCode[]);
    expect(flags.map((f) => f.code)).toEqual(["freeze-authority"]);
  });

  it("de-duplicates repeated codes", () => {
    const flags = orderSafetyFlags([
      "mint-authority",
      "mint-authority",
    ] as SafetyFlagCode[]);
    expect(flags).toHaveLength(1);
  });

  it("returns [] for missing / empty input", () => {
    expect(orderSafetyFlags()).toEqual([]);
    expect(orderSafetyFlags(null)).toEqual([]);
    expect(orderSafetyFlags([])).toEqual([]);
  });
});

describe("blockingFlags / headlineBlockingFlag", () => {
  it("keeps only the findings that cost the endorsement", () => {
    const codes: SafetyFlagCode[] = [
      "mint-authority",
      "freeze-authority",
      "mutable-metadata",
    ];
    expect(blockingFlags(codes).map((f) => f.code)).toEqual([
      "freeze-authority",
    ]);
  });

  it("headlines the first blocking finding", () => {
    expect(
      headlineBlockingFlag(["transfer-hook", "freeze-authority"])!.code
    ).toBe("transfer-hook");
  });

  it("headlines null when nothing blocks — caution alone is not a headline", () => {
    expect(headlineBlockingFlag(["mint-authority", "low-liquidity"])).toBeNull();
    expect(headlineBlockingFlag([])).toBeNull();
    expect(headlineBlockingFlag()).toBeNull();
  });
});

describe("isDangerous — the single gate on gold/crown treatment", () => {
  it("is true only for an explicit danger level", () => {
    expect(isDangerous("danger")).toBe(true);
    expect(isDangerous("caution")).toBe(false);
    expect(isDangerous("clear")).toBe(false);
  });

  it("does not block the crown for unknown or unassessed tokens", () => {
    // An RPC hiccup must not punish every token — but see SafetyChips: neither
    // state may ever render as a clean result.
    expect(isDangerous("unknown")).toBe(false);
    expect(isDangerous(undefined)).toBe(false);
    expect(isDangerous(null)).toBe(false);
  });
});
