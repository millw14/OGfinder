import { describe, it, expect } from "vitest";
import { computeHolderShare } from "@/lib/helius";

describe("computeHolderShare", () => {
  it("computes top-10 and largest shares from descending amounts", () => {
    // 20 accounts of 10 each, supply 1000 → top 10 hold 100/1000 = 10%.
    const amounts = Array.from({ length: 20 }, () => 10);
    expect(computeHolderShare(amounts, 1000)).toEqual({
      topTenPct: 10,
      largestPct: 1,
    });
  });

  it("sums only the first 10 accounts", () => {
    const amounts = [50, ...Array.from({ length: 15 }, () => 5)];
    // top 10 = 50 + 9*5 = 95 of 1000
    expect(computeHolderShare(amounts, 1000)).toEqual({
      topTenPct: 9.5,
      largestPct: 5,
    });
  });

  it("handles fewer than 10 accounts", () => {
    expect(computeHolderShare([600, 300], 1000)).toEqual({
      topTenPct: 90,
      largestPct: 60,
    });
  });

  it("clamps both percentages at 100 (imprecise >2^53 raw supplies)", () => {
    // Stale/imprecise supply smaller than the observed balances.
    expect(computeHolderShare([2000, 500], 1000)).toEqual({
      topTenPct: 100,
      largestPct: 100,
    });
  });

  it("drops non-finite and negative amounts instead of poisoning the sum", () => {
    expect(computeHolderShare([NaN, 100, -5, Infinity, 100], 1000)).toEqual({
      topTenPct: 20,
      largestPct: 10,
    });
  });

  it("returns null on zero, negative, or non-finite supply", () => {
    expect(computeHolderShare([100], 0)).toBeNull();
    expect(computeHolderShare([100], -1)).toBeNull();
    expect(computeHolderShare([100], NaN)).toBeNull();
  });

  it("returns null when no valid amounts remain", () => {
    expect(computeHolderShare([], 1000)).toBeNull();
    expect(computeHolderShare([NaN, -1], 1000)).toBeNull();
  });
});
