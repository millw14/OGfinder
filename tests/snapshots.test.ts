import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TokenResult, FlipInfo } from "@/lib/types";

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshSnapshots() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const snapshots = await import("@/lib/snapshots");
  const watches = await import("@/lib/watches");
  // Same module registry → same DB singleton as snapshots.
  const urlIndex = await import("@/lib/url-index");
  return { ...snapshots, ...watches, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

type Lib = Awaited<ReturnType<typeof freshSnapshots>>;

const T0 = 1_700_000_000_000;

function token(mint: string, over?: Partial<TokenResult>): TokenResult {
  return {
    mint,
    displayName: `Name ${mint}`,
    displaySymbol: mint.slice(0, 3).toUpperCase(),
    slot: null,
    createdAtMs: T0,
    createdAt: new Date(T0).toISOString(),
    dexId: null,
    confidence: 80,
    confidenceLabel: "",
    rank: 0,
    rankLabel: "",
    timeSource: "helius",
    marketCapUsd: null,
    fdvUsd: null,
    priceUsd: null,
    liquidityUsd: null,
    ...over,
  };
}

interface SnapRow {
  id: number;
  taken_at: number;
  rank1_mint: string;
  top_json: string;
}

function snapshotRows(lib: Lib, q: string): SnapRow[] {
  return lib
    .getDb()
    .prepare(
      `SELECT id, taken_at, rank1_mint, top_json FROM query_snapshots
       WHERE query_norm = ? ORDER BY taken_at DESC, id DESC`
    )
    .all(q) as SnapRow[];
}

const THROTTLE_MS = 31 * 60 * 1000;

/** Backdate all snapshots so the 30-min capture throttle clears. */
function backdate(lib: Lib, ms: number = THROTTLE_MS): void {
  lib
    .getDb()
    .prepare("UPDATE query_snapshots SET taken_at = taken_at - ?")
    .run(ms);
}

/** Two captures in sequence: `older` first, throttle cleared, then `newer`. */
function captureTwo(
  lib: Lib,
  q: string,
  older: TokenResult[],
  newer: TokenResult[]
): void {
  lib.captureSnapshot(q, older);
  backdate(lib);
  lib.captureSnapshot(q, newer);
}

function flipAlertRows(lib: Lib, watchId: number) {
  return lib
    .getDb()
    .prepare(
      `SELECT kind, mint, name, payload, matched_at FROM alerts
       WHERE watch_id = ? AND kind = 'flip' ORDER BY id`
    )
    .all(watchId) as {
    kind: string;
    mint: string | null;
    name: string | null;
    payload: string | null;
    matched_at: number;
  }[];
}

describe("captureSnapshot", () => {
  it("skips empty results and a rank-1 without a creation time", async () => {
    const lib = await freshSnapshots();
    lib.captureSnapshot("guarded query", []);
    lib.captureSnapshot("guarded query", [
      token("OgMint", { createdAtMs: null }),
    ]);
    expect(snapshotRows(lib, "guarded query")).toHaveLength(0);
  });

  it("throttles captures to one per 30 minutes per query", async () => {
    const lib = await freshSnapshots();
    lib.captureSnapshot("throttled q", [token("OgMint")]);
    lib.captureSnapshot("throttled q", [token("OgMint")]);
    expect(snapshotRows(lib, "throttled q")).toHaveLength(1);
    backdate(lib);
    lib.captureSnapshot("throttled q", [token("OgMint")]);
    expect(snapshotRows(lib, "throttled q")).toHaveLength(2);
  });

  it("stores the top 10 with nullable metrics kept null, rank1 = first result", async () => {
    const lib = await freshSnapshots();
    const results = Array.from({ length: 12 }, (_, i) =>
      token(`Mint${i}`, i === 0 ? { marketCapUsd: 500 } : {})
    );
    lib.captureSnapshot("top ten q", results);
    const rows = snapshotRows(lib, "top ten q");
    expect(rows).toHaveLength(1);
    expect(rows[0].rank1_mint).toBe("Mint0");
    const top = JSON.parse(rows[0].top_json) as {
      mint: string;
      rank: number;
      marketCapUsd: number | null;
      liquidityUsd: number | null;
      priceUsd: number | null;
    }[];
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ mint: "Mint0", rank: 1, marketCapUsd: 500 });
    // Never coerced: missing metrics stay null, not 0.
    expect(top[1].marketCapUsd).toBeNull();
    expect(top[1].liquidityUsd).toBeNull();
    expect(top[1].priceUsd).toBeNull();
  });

  it("keeps only the newest 20 snapshots per query", async () => {
    const lib = await freshSnapshots();
    for (let i = 0; i < 22; i++) {
      lib.captureSnapshot("capped q", [token("OgMint")]);
      backdate(lib);
    }
    // Other queries are untouched by the per-query cap.
    lib.captureSnapshot("other q", [token("OtherMint")]);
    expect(snapshotRows(lib, "capped q")).toHaveLength(20);
    expect(snapshotRows(lib, "other q")).toHaveLength(1);
  });
});

describe("getSearchHistory", () => {
  const OG = "OgMint";
  const CH = "ChallengerMint";

  it("returns null with no snapshots; one snapshot has no flip verdict", async () => {
    const lib = await freshSnapshots();
    expect(lib.getSearchHistory("nothing here")).toBeNull();
    lib.captureSnapshot("single q", [token(OG)]);
    const h = lib.getSearchHistory("single q");
    expect(h).not.toBeNull();
    expect(h!.snapshotCount).toBe(1);
    expect(h!.firstSnapshotAt).toBeGreaterThan(0);
    expect(h!.flip).toBeNull();
  });

  it("detects a flip by market cap when both sides carry it in both snapshots", async () => {
    const lib = await freshSnapshots();
    captureTwo(
      lib,
      "mc flip q",
      [token(OG, { marketCapUsd: 100 }), token(CH, { marketCapUsd: 50 })],
      [token(OG, { marketCapUsd: 100 }), token(CH, { marketCapUsd: 500 })]
    );
    const flip = lib.getSearchHistory("mc flip q")!.flip!;
    expect(flip.flipped).toBe(true);
    expect(flip.metric).toBe("marketcap");
    expect(flip.og).toMatchObject({ mint: OG, value: 100 });
    expect(flip.challenger).toMatchObject({ mint: CH, value: 500 });
    expect(flip.at).toBeGreaterThan(0);
  });

  it("falls back to liquidity when market cap is incomplete on either side", async () => {
    const lib = await freshSnapshots();
    captureTwo(
      lib,
      "liq flip q",
      [
        // OG has no market cap in the older snapshot — MC not comparable.
        token(OG, { liquidityUsd: 100 }),
        token(CH, { marketCapUsd: 10, liquidityUsd: 10 }),
      ],
      [
        token(OG, { marketCapUsd: 900, liquidityUsd: 100 }),
        token(CH, { marketCapUsd: 10, liquidityUsd: 300 }),
      ]
    );
    const flip = lib.getSearchHistory("liq flip q")!.flip!;
    expect(flip.flipped).toBe(true);
    expect(flip.metric).toBe("liquidity");
    expect(flip.challenger).toMatchObject({ mint: CH, value: 300 });
  });

  it("gives no verdict when neither metric is complete on both sides", async () => {
    const lib = await freshSnapshots();
    captureTwo(
      lib,
      "no verdict q",
      [token(OG, { marketCapUsd: 100 }), token(CH, { liquidityUsd: 50 })],
      [token(OG, { liquidityUsd: 100 }), token(CH, { marketCapUsd: 500 })]
    );
    const h = lib.getSearchHistory("no verdict q")!;
    expect(h.snapshotCount).toBe(2);
    expect(h.flip).toBeNull();
  });

  it("never mixes metrics: a market-cap verdict is final even if liquidity flipped", async () => {
    const lib = await freshSnapshots();
    captureTwo(
      lib,
      "no mix q",
      [
        token(OG, { marketCapUsd: 1000, liquidityUsd: 100 }),
        token(CH, { marketCapUsd: 50, liquidityUsd: 50 }),
      ],
      [
        // OG still leads on MC; challenger leads on liquidity — no flip.
        token(OG, { marketCapUsd: 1000, liquidityUsd: 100 }),
        token(CH, { marketCapUsd: 500, liquidityUsd: 900 }),
      ]
    );
    expect(lib.getSearchHistory("no mix q")!.flip).toBeNull();
  });

  it("detects the OG reclaiming a lead it had lost", async () => {
    const lib = await freshSnapshots();
    captureTwo(
      lib,
      "reclaim q",
      // Older: challenger ahead on MC (rank1 is still the OG — ranked by age).
      [token(OG, { marketCapUsd: 100 }), token(CH, { marketCapUsd: 500 })],
      [token(OG, { marketCapUsd: 900 }), token(CH, { marketCapUsd: 500 })]
    );
    const flip = lib.getSearchHistory("reclaim q")!.flip!;
    expect(flip.flipped).toBe(false);
    expect(flip.reclaimed).toBe(true);
    expect(flip.metric).toBe("marketcap");
    expect(flip.og).toMatchObject({ mint: OG, value: 900 });
    expect(flip.challenger).toMatchObject({ mint: CH, value: 500 });
  });
});

describe("detectAndRecordFlip", () => {
  const OG = "OgMint";
  const CH = "ChallengerMint";
  const QUERY = "wojak classic";

  function createWatchOk(lib: Lib, ip: string) {
    const res = lib.createWatch({ query: QUERY, ip });
    if (!res.ok) throw new Error(`createWatch failed: ${res.error}`);
    return res.watch;
  }

  function flipScenario(lib: Lib): void {
    captureTwo(
      lib,
      QUERY,
      [token(OG, { marketCapUsd: 100 }), token(CH, { marketCapUsd: 50 })],
      [token(OG, { marketCapUsd: 100 }), token(CH, { marketCapUsd: 500 })]
    );
    lib.detectAndRecordFlip(QUERY);
  }

  it("inserts a kind='flip' alert (mint NULL, FlipInfo payload) on a new flip", async () => {
    const lib = await freshSnapshots();
    const w = createWatchOk(lib, "1.1.1.1");
    flipScenario(lib);
    const rows = flipAlertRows(lib, w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].mint).toBeNull();
    expect(rows[0].name).toBe(`Name ${CH}`);
    const payload = JSON.parse(rows[0].payload!) as FlipInfo;
    expect(payload.flipped).toBe(true);
    expect(payload.metric).toBe("marketcap");
    expect(payload.challenger.mint).toBe(CH);
  });

  it("only fires right after a capture: repeat calls and throttled captures no-op", async () => {
    const lib = await freshSnapshots();
    const w = createWatchOk(lib, "1.1.1.1");
    flipScenario(lib);
    // Marker consumed — an immediate repeat inserts nothing.
    lib.detectAndRecordFlip(QUERY);
    // Throttled capture (< 30 min since last) → no marker → no alert.
    lib.captureSnapshot(QUERY, [
      token(OG, { marketCapUsd: 100 }),
      token(CH, { marketCapUsd: 600 }),
    ]);
    lib.detectAndRecordFlip(QUERY);
    expect(flipAlertRows(lib, w.id)).toHaveLength(1);
  });

  it("does not re-alert while the same challenger stays ahead; re-flips alert again", async () => {
    const lib = await freshSnapshots();
    const w = createWatchOk(lib, "1.1.1.1");
    flipScenario(lib);
    // Challenger still ahead on the next capture — same flip, no new alert.
    backdate(lib);
    lib.captureSnapshot(QUERY, [
      token(OG, { marketCapUsd: 100 }),
      token(CH, { marketCapUsd: 700 }),
    ]);
    lib.detectAndRecordFlip(QUERY);
    expect(flipAlertRows(lib, w.id)).toHaveLength(1);
    // OG reclaims — no alert (reclaims never alert).
    backdate(lib);
    lib.captureSnapshot(QUERY, [
      token(OG, { marketCapUsd: 1000 }),
      token(CH, { marketCapUsd: 700 }),
    ]);
    lib.detectAndRecordFlip(QUERY);
    expect(flipAlertRows(lib, w.id)).toHaveLength(1);
    // A fresh flip after the reclaim alerts again (NULL mint allows repeats).
    backdate(lib);
    lib.captureSnapshot(QUERY, [
      token(OG, { marketCapUsd: 1000 }),
      token(CH, { marketCapUsd: 5000 }),
    ]);
    lib.detectAndRecordFlip(QUERY);
    expect(flipAlertRows(lib, w.id)).toHaveLength(2);
  });

  it("honors the daily cap and only alerts skeleton-matching watches", async () => {
    const lib = await freshSnapshots();
    const capped = createWatchOk(lib, "1.1.1.1");
    const fresh = createWatchOk(lib, "2.2.2.2");
    const unrelated = lib.createWatch({
      query: "different name",
      ip: "3.3.3.3",
    });
    if (!unrelated.ok) throw new Error("unrelated watch failed");
    const today = new Date().toISOString().slice(0, 10);
    lib
      .getDb()
      .prepare(
        "UPDATE watched_queries SET alert_day = ?, alert_count_day = 25 WHERE id = ?"
      )
      .run(today, capped.id);
    flipScenario(lib);
    expect(flipAlertRows(lib, capped.id)).toHaveLength(0);
    expect(flipAlertRows(lib, fresh.id)).toHaveLength(1);
    expect(flipAlertRows(lib, unrelated.watch.id)).toHaveLength(0);
    const cap = lib
      .getDb()
      .prepare("SELECT alert_count_day FROM watched_queries WHERE id = ?")
      .get(fresh.id) as { alert_count_day: number };
    expect(cap.alert_count_day).toBe(1);
  });
});

describe("pruneSnapshots", () => {
  it("drops rows past 30 days, throttled via poll_state", async () => {
    const lib = await freshSnapshots();
    const now = Date.now();
    const seed = lib
      .getDb()
      .prepare(
        `INSERT INTO query_snapshots (query_norm, taken_at, rank1_mint, top_json)
         VALUES (?, ?, ?, '[]')`
      );
    seed.run("old q", now - 31 * 24 * 60 * 60 * 1000, "MintOld");
    seed.run("new q", now - 1000, "MintNew");
    lib.pruneSnapshots();
    expect(snapshotRows(lib, "old q")).toHaveLength(0);
    expect(snapshotRows(lib, "new q")).toHaveLength(1);
    // Throttled: a row that ages past the cutoff is kept within the hour…
    seed.run("old q 2", now - 31 * 24 * 60 * 60 * 1000, "MintOld2");
    lib.pruneSnapshots();
    expect(snapshotRows(lib, "old q 2")).toHaveLength(1);
    // …and pruned once the poll_state gate clears.
    lib.setPollState("snapshots:prune_at", String(now - 2 * 60 * 60 * 1000));
    lib.pruneSnapshots();
    expect(snapshotRows(lib, "old q 2")).toHaveLength(0);
  });
});
