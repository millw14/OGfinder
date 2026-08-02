import { describe, it, expect, beforeEach, vi } from "vitest";

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshDiscovery() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const discovery = await import("@/lib/discovery");
  // Same module registry → same DB singleton as discovery.
  const urlIndex = await import("@/lib/url-index");
  return { ...discovery, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

interface DiscoveredRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  name_skeleton: string | null;
  source: string;
  first_seen_at: number;
  named_at: number | null;
  pair_created_at: number | null;
}

describe("discovery", () => {
  it("preserves first-seen name/symbol/skeleton/source/pair time across re-records", async () => {
    const d = await freshDiscovery();
    d.recordDiscoveredTokens(
      [{ mint: "MintA", name: "Alpha", symbol: "ALP", pairCreatedAtMs: 111 }],
      "sourceA"
    );
    const before = d
      .getDb()
      .prepare("SELECT * FROM discovered_tokens WHERE mint = ?")
      .get("MintA") as DiscoveredRow;

    d.recordDiscoveredTokens(
      [{ mint: "MintA", name: "Beta", symbol: "BET", pairCreatedAtMs: 222 }],
      "sourceB"
    );
    const after = d
      .getDb()
      .prepare("SELECT * FROM discovered_tokens WHERE mint = ?")
      .get("MintA") as DiscoveredRow;

    expect(after.name).toBe("Alpha");
    expect(after.symbol).toBe("ALP");
    expect(after.name_skeleton).toBe("alpha");
    expect(after.source).toBe("sourceA");
    expect(after.first_seen_at).toBe(before.first_seen_at);
    expect(after.named_at).toBe(before.named_at);
    expect(after.pair_created_at).toBe(111);
  });

  it("returns a newly-named row exactly once", async () => {
    const d = await freshDiscovery();

    // Unnamed discovery: not alertable yet.
    expect(d.recordDiscoveredTokens([{ mint: "MintB" }], "dexscreener")).toEqual(
      []
    );
    expect(d.getUnnamedRecentMints()).toEqual(["MintB"]);

    // Name arrives: returned once, with the folded skeleton.
    const named = d.recordDiscoveredTokens(
      [{ mint: "MintB", name: "Воnk", symbol: "BONK" }], // Cyrillic В + о
      "dexscreener"
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toEqual({
      mint: "MintB",
      name: "Воnk",
      symbol: "BONK",
      nameSkeleton: "bonk",
      source: "dexscreener",
      pairCreatedAtMs: null,
    });
    expect(d.getUnnamedRecentMints()).toEqual([]);

    // Re-records with a name never return the row again.
    expect(
      d.recordDiscoveredTokens([{ mint: "MintB", name: "Воnk" }], "dexscreener")
    ).toEqual([]);
    expect(
      d.recordDiscoveredTokens([{ mint: "MintB", name: "Other" }], "birdeye")
    ).toEqual([]);
  });

  it("returns a NEW-and-named row immediately, once", async () => {
    const d = await freshDiscovery();
    const first = d.recordDiscoveredTokens(
      [{ mint: "MintC", name: "Gamma" }],
      "geckoterminal"
    );
    expect(first).toHaveLength(1);
    expect(first[0].mint).toBe("MintC");
    expect(
      d.recordDiscoveredTokens([{ mint: "MintC", name: "Gamma" }], "geckoterminal")
    ).toEqual([]);
  });

  it("stores NULL skeleton for names empty after folding, but still counts as named", async () => {
    const d = await freshDiscovery();
    const out = d.recordDiscoveredTokens(
      [{ mint: "MintD", name: "\u{1F525}\u{1F525}" }], // emoji-only name
      "birdeye"
    );
    expect(out).toHaveLength(1);
    expect(out[0].nameSkeleton).toBeNull();

    const row = d
      .getDb()
      .prepare("SELECT * FROM discovered_tokens WHERE mint = ?")
      .get("MintD") as DiscoveredRow;
    expect(row.name).toBe("\u{1F525}\u{1F525}");
    expect(row.name_skeleton).toBeNull();
    expect(row.named_at).not.toBeNull();
    // Named (even if skeleton-less) — not a resolution candidate.
    expect(d.getUnnamedRecentMints()).toEqual([]);
  });

  it("treats blank names as unnamed and lists unnamed mints oldest first", async () => {
    const d = await freshDiscovery();
    d.recordDiscoveredTokens([{ mint: "MintOld", name: "   " }], "s");
    d.getDb()
      .prepare("UPDATE discovered_tokens SET first_seen_at = ? WHERE mint = ?")
      .run(Date.now() - 60_000, "MintOld");
    d.recordDiscoveredTokens([{ mint: "MintNew" }], "s");

    expect(d.getUnnamedRecentMints()).toEqual(["MintOld", "MintNew"]);
    expect(d.getUnnamedRecentMints(1)).toEqual(["MintOld"]);
  });

  it("prunes rows past the 14d cutoff, throttled hourly via poll_state", async () => {
    const d = await freshDiscovery();
    const now = Date.now();
    d.recordDiscoveredTokens(
      [{ mint: "MintStale" }, { mint: "MintFresh", name: "Keep" }],
      "s"
    );
    d.getDb()
      .prepare("UPDATE discovered_tokens SET first_seen_at = ? WHERE mint = ?")
      .run(now - 15 * 24 * 60 * 60 * 1000, "MintStale");

    d.pruneDiscoveredTokens();
    const mints = () =>
      (
        d
          .getDb()
          .prepare("SELECT mint FROM discovered_tokens ORDER BY mint")
          .all() as { mint: string }[]
      ).map((r) => r.mint);
    expect(mints()).toEqual(["MintFresh"]);

    // Within the hour: throttled, a re-inserted stale row survives.
    d.recordDiscoveredTokens([{ mint: "MintStale2" }], "s");
    d.getDb()
      .prepare("UPDATE discovered_tokens SET first_seen_at = ? WHERE mint = ?")
      .run(now - 15 * 24 * 60 * 60 * 1000, "MintStale2");
    d.pruneDiscoveredTokens();
    expect(mints()).toEqual(["MintFresh", "MintStale2"]);

    // Expire the throttle: prune runs again.
    d.setPollState("discovered:prune_at", String(now - 2 * 60 * 60 * 1000));
    d.pruneDiscoveredTokens();
    expect(mints()).toEqual(["MintFresh"]);
  });
});
