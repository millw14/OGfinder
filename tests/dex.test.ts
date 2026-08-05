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
        marketCap: 123_456,
        fdv: 222_222,
        baseToken: { address: mint, name: "GroupCase One", symbol: "GC1" },
      }),
      pair({
        dexId: "pumpfun",
        pairCreatedAt: 1_700_000_000_000,
        priceUsd: "0.1",
        liquidity: { usd: 5 },
        marketCap: 1,
        fdv: 2,
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
    expect(tokens[0].dexMarketCapUsd).toBe(123_456);
    expect(tokens[0].dexFdvUsd).toBe(222_222);
  });

  it("takes trade counts from the market pair, never summed across pairs", async () => {
    const mint = "TxnMint11111111111111111111111111111111111";
    stubDexResponse([
      pair({
        dexId: "raydium",
        pairCreatedAt: 1_800_000_000_000,
        liquidity: { usd: 50_000 },
        txns: {
          h24: { buys: 412, sells: 0 },
          h6: { buys: 90, sells: 0 },
          h1: { buys: 3, sells: 0 },
        },
        baseToken: { address: mint, name: "Txncase One", symbol: "TX1" },
      }),
      pair({
        // Older (identity) pair with healthy-looking flow — must NOT mask the
        // dead-sells pattern on the pool the market data comes from.
        dexId: "pumpfun",
        pairCreatedAt: 1_700_000_000_000,
        liquidity: { usd: 10 },
        txns: { h24: { buys: 5, sells: 5 }, h6: { buys: 1, sells: 1 } },
        baseToken: { address: mint, name: "Txncase One", symbol: "TX1" },
      }),
    ]);

    const tokens = await searchDex("txncase one");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].dexId).toBe("pumpfun"); // identity still the oldest pair
    expect(tokens[0].buys24h).toBe(412);
    expect(tokens[0].sells24h).toBe(0);
    expect(tokens[0].buys6h).toBe(90);
    expect(tokens[0].sells6h).toBe(0);
  });

  it("leaves trade counts ABSENT when DexScreener omits them", async () => {
    stubDexResponse([
      pair({
        baseToken: {
          address: "NoTxn11111111111111111111111111111111111111",
          name: "Notxncase",
          symbol: "NTX",
        },
      }),
    ]);
    const tokens = await searchDex("notxncase");
    expect(tokens).toHaveLength(1);
    // Missing must stay missing — 0 would read as a verified zero-sell token.
    expect(tokens[0]).not.toHaveProperty("buys24h");
    expect(tokens[0]).not.toHaveProperty("sells24h");
  });

  it("keeps a partial bucket partial", async () => {
    stubDexResponse([
      pair({
        txns: { h24: { buys: 30 } },
        baseToken: {
          address: "HalfTxn111111111111111111111111111111111111",
          name: "Halftxncase",
          symbol: "HTX",
        },
      }),
    ]);
    const tokens = await searchDex("halftxncase");
    expect(tokens[0].buys24h).toBe(30);
    expect(tokens[0]).not.toHaveProperty("sells24h");
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
