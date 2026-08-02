import { describe, it, expect } from "vitest";
import { parseSwaps, type EnhancedTx } from "@/lib/wallet-analysis";

const W = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

  it("does not record fee dust as cost basis for stable-quoted swaps", () => {
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

    // 0.001 SOL is under the noise floor — no phantom buy.
    expect(map.get("Meme3")).toBeUndefined();
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
  });
});
