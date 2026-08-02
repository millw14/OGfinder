import { describe, it, expect } from "vitest";
import { parseSwaps, computePnl, type EnhancedTx } from "@/lib/wallet-analysis";

const W = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

function tx(over: Partial<EnhancedTx>): EnhancedTx {
  return {
    signature: `sig-${Math.random().toString(36).slice(2)}`,
    timestamp: 1_700_000_000,
    type: "SWAP",
    source: "TEST",
    ...over,
  };
}

describe("parseSwaps", () => {
  it("records a pump.fun buy from accountData when nativeInput is missing", () => {
    const map = parseSwaps(
      [
        tx({
          events: {
            swap: {
              tokenOutputs: [
                {
                  mint: "Meme1",
                  rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
                  userAccount: W,
                },
              ],
            },
          },
          accountData: [{ account: W, nativeBalanceChange: -500_000_000 }],
        }),
      ],
      W,
      []
    );

    expect(map.get("Meme1")?.totalBoughtSol).toBeCloseTo(0.5, 9);
  });

  it("splits the SOL leg evenly across multi-leg outputs", () => {
    const map = parseSwaps(
      [
        tx({
          events: {
            swap: {
              nativeInput: { account: W, amount: "1000000000" },
              tokenOutputs: [
                {
                  mint: "MemeA",
                  rawTokenAmount: { tokenAmount: "1", decimals: 0 },
                  userAccount: W,
                },
                {
                  mint: "MemeB",
                  rawTokenAmount: { tokenAmount: "1", decimals: 0 },
                  userAccount: W,
                },
              ],
            },
          },
          accountData: [{ account: W, nativeBalanceChange: -1_000_000_000 }],
        }),
      ],
      W,
      []
    );

    expect(map.get("MemeA")?.totalBoughtSol).toBeCloseTo(0.5, 9);
    expect(map.get("MemeB")?.totalBoughtSol).toBeCloseTo(0.5, 9);
  });

  it("records raw-adjusted quantities per leg from events.swap", () => {
    const map = parseSwaps(
      [
        tx({
          events: {
            swap: {
              nativeInput: { account: W, amount: "1000000000" },
              tokenOutputs: [
                {
                  // raw 5,000,000 at 6 decimals → 5 UI units
                  mint: "MemeA",
                  rawTokenAmount: { tokenAmount: "5000000", decimals: 6 },
                  userAccount: W,
                },
                {
                  // raw 250 at 2 decimals → 2.5 UI units
                  mint: "MemeB",
                  rawTokenAmount: { tokenAmount: "250", decimals: 2 },
                  userAccount: W,
                },
              ],
            },
          },
          accountData: [{ account: W, nativeBalanceChange: -1_000_000_000 }],
        }),
      ],
      W,
      []
    );

    expect(map.get("MemeA")?.qtyBought).toBeCloseTo(5, 9);
    expect(map.get("MemeB")?.qtyBought).toBeCloseTo(2.5, 9);
  });

  it("records USDC-quoted buys into stable accumulators without SOL dust", () => {
    // USDC → token swap: no SOL leg, wallet native change is just fees.
    const map = parseSwaps(
      [
        tx({
          events: {
            swap: {
              tokenInputs: [
                {
                  mint: USDC,
                  rawTokenAmount: { tokenAmount: "100000000", decimals: 6 },
                  userAccount: W,
                },
              ],
              tokenOutputs: [
                {
                  mint: "Meme3",
                  rawTokenAmount: { tokenAmount: "1000000", decimals: 6 },
                  userAccount: W,
                },
              ],
            },
          },
          accountData: [{ account: W, nativeBalanceChange: -1_000_000 }],
        }),
      ],
      W,
      []
    );

    const acc = map.get("Meme3");
    expect(acc).toBeDefined();
    // 0.001 SOL is under the noise floor — no phantom SOL cost basis.
    expect(acc?.totalBoughtSol).toBe(0);
    expect(acc?.costUsdStable).toBeCloseTo(100, 6);
    expect(acc?.qtyBought).toBeCloseTo(1, 9);
    expect(acc?.approxUsd).toBe(true);
    // The stable itself never becomes a P&L row.
    expect(map.has(USDC)).toBe(false);
  });

  it("records USDT-quoted sells into stable proceeds", () => {
    const map = parseSwaps(
      [
        tx({
          events: {
            swap: {
              tokenInputs: [
                {
                  mint: "Meme6",
                  rawTokenAmount: { tokenAmount: "2000000", decimals: 6 },
                  userAccount: W,
                },
              ],
              tokenOutputs: [
                {
                  mint: USDT,
                  rawTokenAmount: { tokenAmount: "50000000", decimals: 6 },
                  userAccount: W,
                },
              ],
            },
          },
          accountData: [{ account: W, nativeBalanceChange: -1_000_000 }],
        }),
      ],
      W,
      []
    );

    const acc = map.get("Meme6");
    expect(acc?.proceedsUsdStable).toBeCloseTo(50, 6);
    expect(acc?.qtySold).toBeCloseTo(2, 9);
    expect(acc?.approxUsd).toBe(true);
    expect(map.has(USDT)).toBe(false);
  });

  it("ignores plain transfers with no SOL movement", () => {
    const map = parseSwaps(
      [
        tx({
          type: "TRANSFER",
          tokenTransfers: [
            {
              fromUserAccount: W,
              toUserAccount: OTHER,
              mint: "Meme4",
              tokenAmount: 5,
            },
          ],
          accountData: [{ account: W, nativeBalanceChange: 0 }],
        }),
      ],
      W,
      []
    );

    expect(map.has("Meme4")).toBe(false);
  });

  it("records a sell from strategy 2 when the wallet gains SOL", () => {
    const map = parseSwaps(
      [
        tx({
          type: "UNKNOWN",
          tokenTransfers: [
            {
              fromUserAccount: W,
              toUserAccount: OTHER,
              mint: "Meme5",
              tokenAmount: 100,
            },
          ],
          accountData: [{ account: W, nativeBalanceChange: 2_000_000_000 }],
        }),
      ],
      W,
      []
    );

    expect(map.get("Meme5")?.totalSoldSol).toBeCloseTo(2, 9);
    // tokenTransfers.tokenAmount is already decimal-adjusted — passed as-is.
    expect(map.get("Meme5")?.qtySold).toBeCloseTo(100, 9);
  });
});

describe("computePnl", () => {
  it("weighted-average cost: buy 1 SOL for 100 X, sell 50 X for 2 SOL", () => {
    const r = computePnl({
      totalBoughtSol: 1,
      totalSoldSol: 2,
      qtyBought: 100,
      qtySold: 50,
      currentValueSol: 0,
    });
    expect(r.avgCostSol).toBeCloseTo(0.01, 9);
    expect(r.realizedPnlSol).toBeCloseTo(1.5, 9);
    expect(r.remainingQty).toBeCloseTo(50, 9);
    expect(r.remainingBasisSol).toBeCloseTo(0.5, 9);
    expect(r.unrealizedPnlSol).toBeCloseTo(-0.5, 9);
    expect(r.basisIncomplete).toBe(false);
  });

  it("satisfies realized+unrealized = net flows when qtySold <= qtyBought", () => {
    const r = computePnl({
      totalBoughtSol: 3.7,
      totalSoldSol: 1.2,
      qtyBought: 1234,
      qtySold: 456,
      currentValueSol: 2.9,
    });
    expect(r.realizedPnlSol + r.unrealizedPnlSol).toBeCloseTo(
      1.2 - 3.7 + 2.9,
      9
    );
  });

  it("falls back to crude net math when buy quantities are unknown", () => {
    const r = computePnl({
      totalBoughtSol: 1,
      totalSoldSol: 2,
      qtyBought: 0,
      qtySold: 0,
      currentValueSol: 3,
    });
    expect(r.avgCostSol).toBeNull();
    expect(r.realizedPnlSol).toBeCloseTo(1, 9);
    expect(r.unrealizedPnlSol).toBeCloseTo(3, 9);
    expect(r.remainingBasisSol).toBe(0);
    expect(r.basisIncomplete).toBe(false);
  });

  it("caps sold basis and flags basisIncomplete when more sold than bought", () => {
    const r = computePnl({
      totalBoughtSol: 1,
      totalSoldSol: 3,
      qtyBought: 100,
      qtySold: 150,
      currentValueSol: 0,
    });
    // Basis of sold capped at everything bought (1 SOL) → realized 3 - 1 = 2
    expect(r.realizedPnlSol).toBeCloseTo(2, 9);
    expect(r.remainingQty).toBe(0);
    expect(r.remainingBasisSol).toBe(0);
    expect(r.basisIncomplete).toBe(true);
  });
});
