import { describe, it, expect, beforeEach, vi } from "vitest";

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshTrending() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const trending = await import("@/lib/trending");
  // Same module registry → same DB singleton as trending.
  const urlIndex = await import("@/lib/url-index");
  return { ...trending, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

type Lib = Awaited<ReturnType<typeof freshTrending>>;

interface SeedRow {
  mint: string;
  name: string | null;
  symbol?: string | null;
  skeleton: string | null;
  firstSeenAt: number;
  pairCreatedAt?: number | null;
}

function seed(lib: Lib, rows: SeedRow[]): void {
  const stmt = lib
    .getDb()
    .prepare(
      `INSERT INTO discovered_tokens
         (mint, name, symbol, name_skeleton, source, first_seen_at, named_at, pair_created_at)
       VALUES (?, ?, ?, ?, 'test', ?, ?, ?)`
    );
  for (const r of rows) {
    stmt.run(
      r.mint,
      r.name,
      r.symbol ?? null,
      r.skeleton,
      r.firstSeenAt,
      r.name ? r.firstSeenAt : null,
      r.pairCreatedAt ?? null
    );
  }
}

describe("trending clusters", () => {
  it("requires >=3 launches and skeleton length >=3", async () => {
    const lib = await freshTrending();
    const now = Date.now();
    seed(lib, [
      // Qualifies: 3 members, skeleton "bonk".
      { mint: "B1", name: "Bonk", skeleton: "bonk", firstSeenAt: now - 3000 },
      { mint: "B2", name: "Bonk", skeleton: "bonk", firstSeenAt: now - 2000 },
      { mint: "B3", name: "Bonk", skeleton: "bonk", firstSeenAt: now - 1000 },
      // Too small: only 2 members.
      { mint: "W1", name: "Wif", skeleton: "wif", firstSeenAt: now - 2000 },
      { mint: "W2", name: "Wif", skeleton: "wif", firstSeenAt: now - 1000 },
      // Skeleton too short: "ai" is 2 chars, even with 3 members.
      { mint: "A1", name: "AI", skeleton: "ai", firstSeenAt: now - 3000 },
      { mint: "A2", name: "AI", skeleton: "ai", firstSeenAt: now - 2000 },
      { mint: "A3", name: "AI", skeleton: "ai", firstSeenAt: now - 1000 },
      // Null skeleton never clusters.
      { mint: "E1", name: "🔥", skeleton: null, firstSeenAt: now - 1000 },
    ]);

    const clusters = lib.queryTrendingClusters("24h");
    expect(clusters).toHaveLength(1);
    expect(clusters[0].skeleton).toBe("bonk");
    expect(clusters[0].launches).toBe(3);
    expect(clusters[0].members.map((m) => m.mint)).toEqual(["B3", "B2", "B1"]);
  });

  it("orders by launches desc and applies the window cutoff", async () => {
    const lib = await freshTrending();
    const now = Date.now();
    const h = 60 * 60 * 1000;
    seed(lib, [
      // "pepe": 4 in the last 24h.
      { mint: "P1", name: "Pepe", skeleton: "pepe", firstSeenAt: now - 4 * h },
      { mint: "P2", name: "Pepe", skeleton: "pepe", firstSeenAt: now - 3 * h },
      { mint: "P3", name: "Pepe", skeleton: "pepe", firstSeenAt: now - 2 * h },
      { mint: "P4", name: "Pepe", skeleton: "pepe", firstSeenAt: now - 1 * h },
      // "doge": 2 in the last 24h + 1 three days old → only a cluster at 7d.
      { mint: "D1", name: "Doge", skeleton: "doge", firstSeenAt: now - 72 * h },
      { mint: "D2", name: "Doge", skeleton: "doge", firstSeenAt: now - 2 * h },
      { mint: "D3", name: "Doge", skeleton: "doge", firstSeenAt: now - 1 * h },
    ]);

    const day = lib.queryTrendingClusters("24h");
    expect(day.map((c) => c.skeleton)).toEqual(["pepe"]);

    const week = lib.queryTrendingClusters("7d");
    expect(week.map((c) => c.skeleton)).toEqual(["pepe", "doge"]);
    expect(week[0].launches).toBe(4);
    expect(week[1].launches).toBe(3);
    // Members outside the window are excluded from the 24h view entirely.
    const dayLaunches = day.find((c) => c.skeleton === "doge");
    expect(dayLaunches).toBeUndefined();
  });

  it("picks the most frequent raw name (and its symbol) among top members", async () => {
    const lib = await freshTrending();
    const now = Date.now();
    seed(lib, [
      {
        mint: "M1",
        name: "dogwifhat",
        symbol: "WIF1",
        skeleton: "dogwifhat",
        firstSeenAt: now - 5000,
      },
      {
        mint: "M2",
        name: "Dogwifhat",
        symbol: "WIF2",
        skeleton: "dogwifhat",
        firstSeenAt: now - 4000,
      },
      {
        mint: "M3",
        name: "Dogwifhat",
        symbol: "WIF3",
        skeleton: "dogwifhat",
        firstSeenAt: now - 3000,
      },
      {
        mint: "M4",
        name: "DOGWIFHAT",
        symbol: "WIF4",
        skeleton: "dogwifhat",
        firstSeenAt: now - 2000,
      },
    ]);

    const [cluster] = lib.queryTrendingClusters("24h");
    expect(cluster.representativeName).toBe("Dogwifhat");
    // Symbol comes from the newest member carrying the representative name.
    expect(cluster.representativeSymbol).toBe("WIF3");
  });

  it("computes oldest_known as MIN(COALESCE(pair_created_at, first_seen_at))", async () => {
    const lib = await freshTrending();
    const now = Date.now();
    const h = 60 * 60 * 1000;
    seed(lib, [
      // Seen 1h ago but its pair was created 20h ago → drives oldest_known.
      {
        mint: "O1",
        name: "Moon",
        skeleton: "moon",
        firstSeenAt: now - 1 * h,
        pairCreatedAt: now - 20 * h,
      },
      // No pair time → falls back to first_seen_at.
      { mint: "O2", name: "Moon", skeleton: "moon", firstSeenAt: now - 5 * h },
      { mint: "O3", name: "Moon", skeleton: "moon", firstSeenAt: now - 2 * h },
    ]);

    const [cluster] = lib.queryTrendingClusters("24h");
    expect(cluster.oldestKnownMs).toBe(now - 20 * h);
    expect(cluster.newestSeenMs).toBe(now - 1 * h);
    // Market fields stay null in the sync clustering pass.
    expect(cluster.marketCapUsd).toBeNull();
    expect(cluster.volumeUsd24h).toBeNull();
  });

  it("caps members at 5 newest-first while launches counts the whole window", async () => {
    const lib = await freshTrending();
    const now = Date.now();
    seed(
      lib,
      Array.from({ length: 7 }, (_, i) => ({
        mint: `C${i}`,
        name: "Cat",
        skeleton: "cat",
        firstSeenAt: now - (i + 1) * 1000,
      }))
    );

    const [cluster] = lib.queryTrendingClusters("24h");
    expect(cluster.launches).toBe(7);
    expect(cluster.members).toHaveLength(5);
    expect(cluster.members.map((m) => m.mint)).toEqual([
      "C0",
      "C1",
      "C2",
      "C3",
      "C4",
    ]);
  });
});
