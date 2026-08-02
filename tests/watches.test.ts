import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NewDiscovery } from "@/lib/discovery";

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshWatches() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const watches = await import("@/lib/watches");
  // Same module registry → same DB singleton as watches.
  const urlIndex = await import("@/lib/url-index");
  return { ...watches, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

const HEX32 = /^[0-9a-f]{32}$/;

function discovery(
  mint: string,
  nameSkeleton: string | null,
  extra?: Partial<NewDiscovery>
): NewDiscovery {
  return {
    mint,
    name: nameSkeleton ?? "🔥",
    symbol: null,
    nameSkeleton,
    source: "test",
    pairCreatedAtMs: null,
    ...extra,
  };
}

type Lib = Awaited<ReturnType<typeof freshWatches>>;

function createOk(lib: Lib, input: Parameters<Lib["createWatch"]>[0]) {
  const res = lib.createWatch(input);
  if (!res.ok) throw new Error(`createWatch failed: ${res.error}`);
  return res.watch;
}

function alertRows(lib: Lib, watchId: number) {
  return lib
    .getDb()
    .prepare(
      "SELECT mint, name, source, matched_at FROM alerts WHERE watch_id = ? ORDER BY id"
    )
    .all(watchId) as { mint: string; name: string; source: string }[];
}

describe("createWatch", () => {
  it("creates a watch with a 32-hex secret and contains mode for long skeletons", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "watchtest longname", ip: "1.1.1.1" });
    expect(w.id).toBeGreaterThan(0);
    expect(w.secret).toMatch(HEX32);
    expect(w.displayQuery).toBe("watchtest longname");
    expect(w.querySkeleton).toBe("watchtest longname");
    expect(w.matchMode).toBe("contains");
    expect(w.kind).toBe("name");
    expect(w.existing).toBe(false);
  });

  it("uses exact mode when the skeleton is under 5 chars", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "Bonk", ip: "1.1.1.1" });
    expect(w.querySkeleton).toBe("bonk");
    expect(w.matchMode).toBe("exact");
  });

  it("rejects invalid queries: too short, too long, skeleton-degenerate", async () => {
    const lib = await freshWatches();
    expect(lib.createWatch({ query: "x", ip: "a" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      lib.createWatch({ query: "z".repeat(31), ip: "a" })
    ).toEqual({ ok: false, error: "invalid" });
    // Emoji-only: passes the raw length check but folds to an empty skeleton.
    expect(lib.createWatch({ query: "🔥🔥🔥", ip: "a" })).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("same ip+skeleton is idempotent; another ip gets its own watch", async () => {
    const lib = await freshWatches();
    const first = createOk(lib, { query: "pepe classic", ip: "1.1.1.1" });
    // Different display casing, same skeleton → same watch back.
    const dup = createOk(lib, { query: "PEPE Classic", ip: "1.1.1.1" });
    expect(dup.id).toBe(first.id);
    expect(dup.secret).toBe(first.secret);
    expect(dup.existing).toBe(true);
    const other = createOk(lib, { query: "pepe classic", ip: "2.2.2.2" });
    expect(other.id).not.toBe(first.id);
    expect(other.secret).not.toBe(first.secret);
  });

  it("enforces the per-IP cap of 10 with 'limit'", async () => {
    const lib = await freshWatches();
    for (let i = 0; i < 10; i++) {
      createOk(lib, { query: `capped name ${i}`, ip: "9.9.9.9" });
    }
    expect(
      lib.createWatch({ query: "one more name", ip: "9.9.9.9" })
    ).toEqual({ ok: false, error: "limit" });
    // A different ip is unaffected.
    expect(
      lib.createWatch({ query: "one more name", ip: "8.8.8.8" }).ok
    ).toBe(true);
  });

  it("enforces the global cap of 2000 with 'full'", async () => {
    const lib = await freshWatches();
    const seed = lib.getDb().prepare(
      `INSERT INTO watched_queries
         (kind, query_skeleton, display_query, match_mode, secret, created_by_ip, created_at)
       VALUES ('name', ?, ?, 'contains', ?, ?, ?)`
    );
    const tx = lib.getDb().transaction(() => {
      for (let i = 0; i < 2000; i++) {
        seed.run(`seeded ${i}`, `seeded ${i}`, `secret${i}`, `ip${i}`, 1);
      }
    });
    tx();
    expect(
      lib.createWatch({ query: "past the cap", ip: "fresh-ip" })
    ).toEqual({ ok: false, error: "full" });
  });

  it("stores originMint only for mint-cluster watches", async () => {
    const lib = await freshWatches();
    const cluster = createOk(lib, {
      query: "cool cat token",
      kind: "mint-cluster",
      originMint: "MintOrigin",
      ip: "a",
    });
    expect(cluster.kind).toBe("mint-cluster");
    expect(cluster.originMint).toBe("MintOrigin");
    const name = createOk(lib, {
      query: "plain name watch",
      originMint: "MintIgnored",
      ip: "a",
    });
    expect(name.originMint).toBeNull();
  });
});

describe("deleteWatch", () => {
  it("is indistinguishable for wrong secret vs missing id, deletes on match", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "delete me later", ip: "a" });
    // Wrong secret (same length) and unknown id both fail identically.
    expect(lib.deleteWatch(w.id, "f".repeat(32))).toBe(false);
    expect(lib.deleteWatch(w.id + 999, w.secret)).toBe(false);
    // Length-mismatched secret can't reach timingSafeEqual.
    expect(lib.deleteWatch(w.id, "short")).toBe(false);
    expect(lib.deleteWatch(w.id, w.secret)).toBe(true);
    expect(lib.deleteWatch(w.id, w.secret)).toBe(false);
  });

  it("cascades alerts on delete (foreign_keys=ON)", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "cascade victim", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintClone", "cascade victim v2"),
    ]);
    expect(alertRows(lib, w.id)).toHaveLength(1);
    expect(lib.deleteWatch(w.id, w.secret)).toBe(true);
    const count = lib
      .getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM alerts")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});

describe("matchDiscoveriesAgainstWatches", () => {
  it("contains mode matches substrings; exact mode requires equality", async () => {
    const lib = await freshWatches();
    const contains = createOk(lib, { query: "watchtest longname", ip: "a" });
    const exact = createOk(lib, { query: "bonk", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("Mint1", "super watchtest longname v2"),
      discovery("Mint2", "watchtest"), // partial of the contains query — no hit
      discovery("Mint3", "bonk"),
      discovery("Mint4", "bonk inu"), // exact watch must not substring-match
      discovery("Mint5", null), // skeleton-less — never matchable
    ]);
    expect(alertRows(lib, contains.id).map((r) => r.mint)).toEqual(["Mint1"]);
    expect(alertRows(lib, exact.id).map((r) => r.mint)).toEqual(["Mint3"]);
  });

  it("skips tokens with a known pair age over 72h; unknown age alerts", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "aged token name", ip: "a" });
    const now = Date.now();
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintOld", "aged token name", {
        pairCreatedAtMs: now - 73 * 60 * 60 * 1000,
      }),
      discovery("MintFresh", "aged token name x", {
        pairCreatedAtMs: now - 60 * 60 * 1000,
      }),
      discovery("MintUnknown", "aged token name y"),
    ]);
    expect(alertRows(lib, w.id).map((r) => r.mint)).toEqual([
      "MintFresh",
      "MintUnknown",
    ]);
  });

  it("never alerts a mint-cluster watch on its own origin mint", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, {
      query: "cool cat token",
      kind: "mint-cluster",
      originMint: "MintOrigin",
      ip: "a",
    });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintOrigin", "cool cat token"),
      discovery("MintCopy", "cool cat token 2"),
    ]);
    expect(alertRows(lib, w.id).map((r) => r.mint)).toEqual(["MintCopy"]);
  });

  it("caps alerts at 25 per watch per UTC day", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "spammed name", ip: "a" });
    const batch = Array.from({ length: 30 }, (_, i) =>
      discovery(`MintSpam${i}`, `spammed name ${i}`)
    );
    lib.matchDiscoveriesAgainstWatches(batch);
    expect(alertRows(lib, w.id)).toHaveLength(25);
    const row = lib
      .getDb()
      .prepare(
        "SELECT alert_day, alert_count_day FROM watched_queries WHERE id = ?"
      )
      .get(w.id) as { alert_day: string; alert_count_day: number };
    expect(row.alert_count_day).toBe(25);
    expect(row.alert_day).toBe(new Date().toISOString().slice(0, 10));

    // Still capped on a later tick the same day.
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintSpamLate", "spammed name late"),
    ]);
    expect(alertRows(lib, w.id)).toHaveLength(25);

    // A new UTC day resets the count.
    lib
      .getDb()
      .prepare("UPDATE watched_queries SET alert_day = '2000-01-01' WHERE id = ?")
      .run(w.id);
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintSpamNextDay", "spammed name tomorrow"),
    ]);
    expect(alertRows(lib, w.id)).toHaveLength(26);
  });

  it("dedupes cross-source rediscoveries of the same mint", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "double seen", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintDup", "double seen alpha", { source: "dexscreener" }),
    ]);
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintDup", "double seen alpha", { source: "birdeye" }),
    ]);
    const rows = alertRows(lib, w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("dexscreener");
    const cap = lib
      .getDb()
      .prepare("SELECT alert_count_day FROM watched_queries WHERE id = ?")
      .get(w.id) as { alert_count_day: number };
    // The ignored duplicate must not consume daily-cap budget.
    expect(cap.alert_count_day).toBe(1);
  });

  it("picks up watches created after a previous tick (dirty-flag reload)", async () => {
    const lib = await freshWatches();
    const first = createOk(lib, { query: "first watch here", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintA", "first watch here ok"),
    ]);
    const second = createOk(lib, { query: "second watch here", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintB", "second watch here ok"),
    ]);
    expect(alertRows(lib, first.id)).toHaveLength(1);
    expect(alertRows(lib, second.id)).toHaveLength(1);
  });
});

describe("getAlertsForWatches", () => {
  it("returns alerts newest first, omits bad secrets, honors since, bumps last_read_at", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "readable watch", ip: "a" });
    const other = createOk(lib, { query: "other watch name", ip: "a" });
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintR1", "readable watch one"),
    ]);
    // Force distinct matched_at ordering.
    lib
      .getDb()
      .prepare("UPDATE alerts SET matched_at = matched_at - 10000 WHERE mint = 'MintR1'")
      .run();
    lib.matchDiscoveriesAgainstWatches([
      discovery("MintR2", "readable watch two"),
    ]);

    const result = lib.getAlertsForWatches([
      { id: w.id, secret: w.secret },
      { id: other.id, secret: "f".repeat(32) }, // wrong secret — omitted
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(w.id);
    expect(result[0].displayQuery).toBe("readable watch");
    expect(result[0].telegramLinked).toBe(false);
    expect(result[0].alerts.map((a) => a.mint)).toEqual(["MintR2", "MintR1"]);
    expect(result[0].alerts[0].kind).toBe("clone");
    expect(result[0].alerts[0].matchedAt).toBeGreaterThan(0);

    const read = lib
      .getDb()
      .prepare("SELECT last_read_at FROM watched_queries WHERE id = ?")
      .get(w.id) as { last_read_at: number | null };
    expect(read.last_read_at).not.toBeNull();

    // since filters out the older alert.
    const older = lib
      .getDb()
      .prepare("SELECT matched_at FROM alerts WHERE mint = 'MintR1'")
      .get() as { matched_at: number };
    const sinceResult = lib.getAlertsForWatches(
      [{ id: w.id, secret: w.secret }],
      older.matched_at
    );
    expect(sinceResult[0].alerts.map((a) => a.mint)).toEqual(["MintR2"]);
  });

  it("caps at 10 pairs and 50 alerts per watch", async () => {
    const lib = await freshWatches();
    const w = createOk(lib, { query: "many alerts name", ip: "a" });
    // Seed 60 alerts directly (the matcher's daily cap would stop at 25).
    const seed = lib.getDb().prepare(
      `INSERT INTO alerts (watch_id, kind, mint, name, matched_at)
       VALUES (?, 'clone', ?, ?, ?)`
    );
    const tx = lib.getDb().transaction(() => {
      for (let i = 0; i < 60; i++) {
        seed.run(w.id, `MintMany${i}`, `many ${i}`, 1000 + i);
      }
    });
    tx();
    const result = lib.getAlertsForWatches([
      { id: w.id, secret: w.secret },
      ...Array.from({ length: 12 }, () => ({ id: 99999, secret: "x" })),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].alerts).toHaveLength(50);
    // Newest first: the highest matched_at leads.
    expect(result[0].alerts[0].mint).toBe("MintMany59");
  });
});
