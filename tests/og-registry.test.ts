import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MintScanPayload } from "@/lib/scan";
import type { TokenResult } from "@/lib/types";

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshRegistry() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const registry = await import("@/lib/og-registry");
  // Same module registry → same DB singleton as og-registry.
  const urlIndex = await import("@/lib/url-index");
  return { ...registry, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

type Lib = Awaited<ReturnType<typeof freshRegistry>>;

const T_OLDEST = Date.parse("2021-01-01T00:00:00.000Z");
const T_OG = Date.parse("2022-12-20T21:10:46.000Z");
const T_CLONE = Date.parse("2023-05-01T00:00:00.000Z");

/** TokenResult fixture; createdAtMs defaults to T_OG (pass null to clear). */
function tok(
  over: Partial<TokenResult> & { mint: string; displayName: string; rank: number }
): TokenResult {
  const createdAtMs = "createdAtMs" in over ? (over.createdAtMs ?? null) : T_OG;
  return {
    displaySymbol: "TOK",
    slot: null,
    dexId: null,
    confidence: 1,
    confidenceLabel: "high",
    rankLabel: "",
    timeSource: "helius",
    ...over,
    createdAtMs,
    createdAt: createdAtMs != null ? new Date(createdAtMs).toISOString() : null,
  };
}

function payload(
  results: TokenResult[],
  scanName: string | null = null
): MintScanPayload {
  return { results, query: "q", scanName, scanSymbol: null };
}

interface RegistryRow {
  name_skeleton: string;
  og_mint: string;
  og_name: string;
  og_symbol: string | null;
  og_created_at_ms: number | null;
  verified_at: number;
  scan_count: number;
}

function rows(lib: Lib): RegistryRow[] {
  return lib
    .getDb()
    .prepare("SELECT * FROM og_registry ORDER BY name_skeleton")
    .all() as RegistryRow[];
}

describe("recordOgFromScan — exact-key semantics", () => {
  it('scanning a "Trump Coin" cohort writes key "trump coin" only, never "trump"', async () => {
    const lib = await freshRegistry();
    // Cohort mixes "Trump", "Trump Coin", "Trump Inu" — full names differ.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "TrumpMint", displayName: "Trump", rank: 1, createdAtMs: T_OLDEST }),
        tok({ mint: "TCoinOG", displayName: "Trump Coin", displaySymbol: "TC", rank: 2, createdAtMs: T_OG }),
        tok({ mint: "TCoinScanned", displayName: "Trump Coin", rank: 3, createdAtMs: T_CLONE }),
        tok({ mint: "TInu", displayName: "Trump Inu", rank: 4, createdAtMs: T_OG }),
      ]),
      "TCoinScanned"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].name_skeleton).toBe("trump coin");
    // OG = oldest EXACT "Trump Coin" — never the older "Trump" (rank 1).
    expect(all[0].og_mint).toBe("TCoinOG");
    expect(all[0].og_name).toBe("Trump Coin");
    expect(all[0].og_symbol).toBe("TC");
    expect(all[0].og_created_at_ms).toBe(T_OG);
    expect(all[0].scan_count).toBe(1);
  });

  it('oldest "Trump" cohort member is never registered when no exact "trump coin" match exists', async () => {
    const lib = await freshRegistry();
    // Scanned token named "Trump Coin" (scanName fallback — not in results),
    // cohort only has "Trump" and "Trump Inu": equality never matches, so
    // NOTHING is written — neither "trump coin" nor "trump".
    lib.recordOgFromScan(
      payload(
        [
          tok({ mint: "TrumpMint", displayName: "Trump", rank: 1, createdAtMs: T_OLDEST }),
          tok({ mint: "TInu", displayName: "Trump Inu", rank: 2, createdAtMs: T_OG }),
        ],
        "Trump Coin"
      ),
      "MissingMint11111111111111111111111111111111"
    );
    expect(rows(lib)).toHaveLength(0);
  });

  it('scanning "Trump" never registers the oldest "trump <anything>" as its OG', async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "TCoinOlder", displayName: "Trump Coin", rank: 1, createdAtMs: T_OLDEST }),
        tok({ mint: "TrumpMint", displayName: "Trump", rank: 2, createdAtMs: T_OG }),
      ]),
      "TrumpMint"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].name_skeleton).toBe("trump");
    expect(all[0].og_mint).toBe("TrumpMint"); // NOT TCoinOlder
  });

  it("matches via skeleton folding (case, emoji padding) but still by equality", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "🔥BONK🔥", rank: 1, createdAtMs: T_OG }),
        tok({ mint: "BonkClone", displayName: "Bonk", rank: 2, createdAtMs: T_CLONE }),
      ]),
      "BonkClone"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].name_skeleton).toBe("bonk");
    expect(all[0].og_mint).toBe("BonkOG");
  });

  it("skips keys shorter than 2 chars", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([tok({ mint: "XMint", displayName: "X", rank: 1 })]),
      "XMint"
    );
    expect(rows(lib)).toHaveLength(0);
  });
});

describe("recordOgFromScan — uncertain OGs are never immortalized", () => {
  const cases: [string, Partial<TokenResult>][] = [
    ["createdAtIsLowerBound", { createdAtIsLowerBound: true }],
    ["pendingAge", { pendingAge: true }],
    ["homoglyphSuspect", { homoglyphSuspect: true }],
    ["missing createdAtMs", { createdAtMs: null }],
  ];
  for (const [label, flags] of cases) {
    it(`does not write when the oldest exact candidate has ${label}`, async () => {
      const lib = await freshRegistry();
      lib.recordOgFromScan(
        payload([
          tok({ mint: "SusOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG, ...flags }),
          // Younger clean candidate exists — must NOT be promoted to OG.
          tok({ mint: "CleanClone", displayName: "Bonk", rank: 2, createdAtMs: T_CLONE }),
        ]),
        "CleanClone"
      );
      expect(rows(lib)).toHaveLength(0);
    });
  }
});

describe("recordOgFromScan — upsert behavior", () => {
  it("bumps scan_count + verified_at on repeat scans of the same OG", async () => {
    const lib = await freshRegistry();
    const p = payload([
      tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
      tok({ mint: "BonkClone", displayName: "Bonk", rank: 2, createdAtMs: T_CLONE }),
    ]);
    lib.recordOgFromScan(p, "BonkClone");
    const first = rows(lib)[0];
    lib.recordOgFromScan(p, "BonkOG");
    const second = rows(lib)[0];
    expect(second.og_mint).toBe("BonkOG");
    expect(second.scan_count).toBe(2);
    expect(second.verified_at).toBeGreaterThanOrEqual(first.verified_at);
  });

  it("overwrites og_mint when a better (older) OG is found", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkA", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
      ]),
      "BonkA"
    );
    expect(rows(lib)[0].og_mint).toBe("BonkA");
    // A later scan surfaces an older exact-match OG.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkTrueOG", displayName: "Bonk", rank: 1, createdAtMs: T_OLDEST }),
        tok({ mint: "BonkA", displayName: "Bonk", rank: 2, createdAtMs: T_OG }),
      ]),
      "BonkA"
    );
    const row = rows(lib)[0];
    expect(row.og_mint).toBe("BonkTrueOG");
    expect(row.og_created_at_ms).toBe(T_OLDEST);
    expect(row.scan_count).toBe(2);
  });
});

describe("getRegisteredOg + freshness window", () => {
  it("returns undefined when absent and the mapped entry when present", async () => {
    const lib = await freshRegistry();
    expect(lib.getRegisteredOg("bonk")).toBeUndefined();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", displaySymbol: "BONK", rank: 1, createdAtMs: T_OG }),
      ]),
      "BonkOG"
    );
    const entry = lib.getRegisteredOg("bonk");
    expect(entry).toBeDefined();
    expect(entry!.ogMint).toBe("BonkOG");
    expect(entry!.ogName).toBe("Bonk");
    expect(entry!.ogSymbol).toBe("BONK");
    expect(entry!.ogCreatedAtMs).toBe(T_OG);
    expect(entry!.scanCount).toBe(1);
    expect(entry!.verifiedAt).toBeGreaterThan(0);
    // Exact-key lookup: the full-name key never answers for a sub-name.
    expect(lib.getRegisteredOg("bonk inu")).toBeUndefined();
  });

  it("isRegistryFresh honors the 24h window boundary", async () => {
    const lib = await freshRegistry();
    const now = 1_800_000_000_000;
    expect(lib.isRegistryFresh(now, now)).toBe(true);
    expect(lib.isRegistryFresh(now - lib.REGISTRY_FRESH_MS + 1, now)).toBe(true);
    expect(lib.isRegistryFresh(now - lib.REGISTRY_FRESH_MS, now)).toBe(false);
    expect(lib.isRegistryFresh(now - lib.REGISTRY_FRESH_MS - 1, now)).toBe(false);
    expect(lib.REGISTRY_FRESH_MS).toBe(24 * 60 * 60 * 1000);
  });
});
