import { describe, it, expect, vi, afterEach } from "vitest";
import { searchDex } from "@/lib/dex";

function stubDexResponse(pairs: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ pairs }),
    }))
  );
}

function pair(over: Record<string, unknown>): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    baseToken: {
      address: "MintA1111111111111111111111111111111111111",
      name: "Token",
      symbol: "TKN",
    },
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchDex", () => {
  it("keeps oldest-pair identity but highest-liquidity market data", async () => {
    const mint = "GroupMint111111111111111111111111111111111";
    stubDexResponse([
      pair({
        dexId: "raydium",
        pairCreatedAt: 1_800_000_000_000,
        priceUsd: "0.5",
        liquidity: { usd: 99_999 },
        baseToken: { address: mint, name: "GroupCase One", symbol: "GC1" },
      }),
      pair({
        dexId: "pumpfun",
        pairCreatedAt: 1_700_000_000_000,
        priceUsd: "0.1",
        liquidity: { usd: 5 },
        baseToken: { address: mint, name: "GroupCase One", symbol: "GC1" },
      }),
    ]);

    const tokens = await searchDex("groupcase one");
    expect(tokens).toHaveLength(1);
    // Launch venue = oldest pair
    expect(tokens[0].dexId).toBe("pumpfun");
    expect(tokens[0].pairCreatedAt).toBe(1_700_000_000_000);
    // Market data = highest-liquidity pair
    expect(tokens[0].liquidityUsd).toBe(99_999);
    expect(tokens[0].priceUsd).toBe(0.5);
  });

  it("re-filters DexScreener fuzzy matches to require the full query", async () => {
    stubDexResponse([
      pair({
        baseToken: {
          address: "Haram1111111111111111111111111111111111111",
          name: "HARAMBE",
          symbol: "HARAMBE",
        },
      }),
    ]);

    const tokens = await searchDex("ara grok");
    expect(tokens).toHaveLength(0);
  });

  it("admits lookalike copycats via skeleton matching", async () => {
    stubDexResponse([
      pair({
        baseToken: {
          address: "Cyril1111111111111111111111111111111111111",
          // Cyrillic В + о
          name: "Воnk skeletoncase",
          symbol: "BONK",
        },
      }),
    ]);

    const tokens = await searchDex("bonk skeletoncase");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].mint).toBe("Cyril1111111111111111111111111111111111111");
  });
});
