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

describe("recordOgFromScan — an unproven lead is never cemented", () => {
  it("refuses to write when a SAME-NAME token below is still a lower bound", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
        // True creation is AT OR BEFORE T_CLONE, by an unknown amount — it
        // could predate BonkOG, so "the OG of bonk" is not established.
        tok({
          mint: "BonkDeep",
          displayName: "Bonk",
          rank: 2,
          createdAtMs: T_CLONE,
          createdAtIsLowerBound: true,
        }),
      ]),
      "BonkOG"
    );
    expect(rows(lib)).toHaveLength(0);
  });

  it("evicts a stored entry once a same-name contender turns up bounded", async () => {
    const lib = await freshRegistry();
    // Day 1: every same-name token was exactly dated, so the key was earned.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
      ]),
      "BonkOG"
    );
    expect(rows(lib)).toHaveLength(1);

    // Day 2: a same-name token appears whose walk was truncated — its true
    // creation is at or BEFORE T_CLONE, so it could predate BonkOG. The stored
    // "the OG of bonk is BonkOG" is no longer provable and must not keep being
    // served instantly for the rest of the 24h window.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
        tok({
          mint: "BonkDeep",
          displayName: "Bonk",
          rank: 2,
          createdAtMs: T_CLONE,
          createdAtIsLowerBound: true,
        }),
      ]),
      "BonkOG"
    );
    expect(rows(lib)).toHaveLength(0);
    expect(lib.getRegisteredOg("bonk")).toBeUndefined();
  });

  it("keeps the stored entry when the scan merely FAILED to date a token", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
      ]),
      "BonkOG"
    );
    // No lower bound anywhere — the leader simply has no date this time (RPC
    // hiccup). Absence of data is not evidence against the stored answer, so
    // nothing new is written AND nothing is thrown away.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: null }),
      ]),
      "BonkOG"
    );
    expect(rows(lib)).toHaveLength(1);
    expect(lib.getRegisteredOg("bonk")!.ogMint).toBe("BonkOG");
  });

  it("declines when the result window is FULL and the cohort verdict is unproven", async () => {
    const lib = await freshRegistry();
    // 100 results = the MAX_RESULTS slice, so same-name tokens we never
    // received could exist below it. The server stamped rank 1 unproven from
    // the pre-slice cohort — that verdict wins over what we can see here.
    const many = Array.from({ length: 100 }, (_, i) =>
      tok({
        mint: `Bonk${i}`,
        displayName: i === 0 ? "Bonk" : `Bonk ${i}`,
        rank: i + 1,
        createdAtMs: T_OG + i * 1000,
      })
    );
    many[0].ageOrderUnproven = true;
    lib.recordOgFromScan(
      { ...payload(many), ageOrderUnproven: true, ageUnresolvedCount: 4 },
      "Bonk0"
    );
    expect(rows(lib)).toHaveLength(0);

    // The identical cohort UNDER the cap is visible in full, so the same-name
    // check is exhaustive and the key is earned.
    const lib2 = await freshRegistry();
    const few = many.slice(0, 99);
    lib2.recordOgFromScan(
      { ...payload(few), ageOrderUnproven: true, ageUnresolvedCount: 4 },
      "Bonk0"
    );
    expect(rows(lib2)).toHaveLength(1);
    expect(rows(lib2)[0].og_mint).toBe("Bonk0");
  });

  it("still writes when the lower-bound token has a DIFFERENT name", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG }),
        // Different key entirely — it can never be "the OG of bonk", however
        // old it turns out to be.
        tok({
          mint: "InuDeep",
          displayName: "Bonk Inu",
          rank: 2,
          createdAtMs: T_CLONE,
          createdAtIsLowerBound: true,
        }),
      ]),
      "BonkOG"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].og_mint).toBe("BonkOG");
  });
});

describe("recordOgFromScan — a dangerous token is never cemented", () => {
  it("refuses to register an OG with a blocking safety flag", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([
        tok({
          mint: "HoneyOG",
          displayName: "Bonk",
          rank: 1,
          createdAtMs: T_OG,
          safetyLevel: "danger",
          safetyFlags: ["no-sells"],
        }),
        // A younger clean token must NOT be promoted in its place.
        tok({ mint: "CleanClone", displayName: "Bonk", rank: 2, createdAtMs: T_CLONE }),
      ]),
      "CleanClone"
    );
    expect(rows(lib)).toHaveLength(0);
  });

  it("registers normally at caution / clear / unknown levels", async () => {
    for (const level of ["caution", "clear", "unknown"] as const) {
      const lib = await freshRegistry();
      lib.recordOgFromScan(
        payload([
          tok({
            mint: "BonkOG",
            displayName: "Bonk",
            rank: 1,
            createdAtMs: T_OG,
            safetyLevel: level,
          }),
        ]),
        "BonkOG"
      );
      expect(rows(lib)).toHaveLength(1);
      expect(rows(lib)[0].og_mint).toBe("BonkOG");
    }
  });

  it("evicts an already-registered OG once it is assessed as dangerous", async () => {
    const lib = await freshRegistry();
    // Day 1: registered before the safety engine had anything to say.
    lib.recordOgFromScan(
      payload([tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG })]),
      "BonkOG"
    );
    expect(rows(lib)).toHaveLength(1);

    // Day 2: a later scan assesses that same mint as dangerous.
    lib.recordOgFromScan(
      payload([
        tok({
          mint: "BonkOG",
          displayName: "Bonk",
          rank: 1,
          createdAtMs: T_OG,
          safetyLevel: "danger",
          safetyFlags: ["transfer-hook"],
        }),
        tok({ mint: "BonkClone", displayName: "Bonk", rank: 2, createdAtMs: T_CLONE }),
      ]),
      "BonkClone"
    );
    // The row is gone — the bot falls back to a full scan instead of serving
    // an instant "this is the OG" for a honeypot.
    expect(rows(lib)).toHaveLength(0);
    expect(lib.getRegisteredOg("bonk")).toBeUndefined();
  });

  it("evicts under a different name key than the one being scanned", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([tok({ mint: "SharedMint", displayName: "Trump", rank: 1, createdAtMs: T_OG })]),
      "SharedMint"
    );
    expect(rows(lib)).toHaveLength(1);
    // Scanning a "Trump Coin" cohort that happens to include the dangerous
    // mint still clears its "trump" row.
    lib.recordOgFromScan(
      payload([
        tok({ mint: "TCoinOG", displayName: "Trump Coin", rank: 1, createdAtMs: T_OG }),
        tok({
          mint: "SharedMint",
          displayName: "Trump",
          rank: 2,
          createdAtMs: T_OG,
          safetyLevel: "danger",
        }),
      ]),
      "TCoinOG"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].name_skeleton).toBe("trump coin");
  });

  it("evictOgMint reports what it removed and is safe to repeat", async () => {
    const lib = await freshRegistry();
    lib.recordOgFromScan(
      payload([tok({ mint: "BonkOG", displayName: "Bonk", rank: 1, createdAtMs: T_OG })]),
      "BonkOG"
    );
    expect(lib.evictOgMint("BonkOG")).toBe(1);
    expect(lib.evictOgMint("BonkOG")).toBe(0);
    expect(lib.evictOgMint("NeverRegistered")).toBe(0);
  });
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

describe("recordOgFromScan — a derivative name is never cemented", () => {
  it("refuses to register a relatedOnly candidate as the OG of a name", async () => {
    const lib = await freshRegistry();
    // Skeleton equality alone would accept this row: the candidate's full name
    // IS the key. But it was flagged as a derivative against the (truncated)
    // search query, and a registry row is served as fact for 24h.
    lib.recordOgFromScan(
      payload([
        tok({
          mint: "RelatedOG",
          displayName: "Karat Life Companion",
          rank: 1,
          createdAtMs: T_OLDEST,
          relatedOnly: true,
        }),
        tok({
          mint: "ScannedMint",
          displayName: "Karat Life Companion",
          rank: 2,
          createdAtMs: T_OG,
        }),
      ]),
      "ScannedMint"
    );
    expect(rows(lib)).toHaveLength(0);
  });

  it("the ordinary case is already refused by skeleton equality alone", async () => {
    const lib = await freshRegistry();
    // "Karate Cat" is the oldest token in the cohort and carries no flag here
    // — the exact-key rule is what keeps it out, independent of relatedOnly.
    lib.recordOgFromScan(
      payload([
        tok({
          mint: "KarateCat",
          displayName: "Karate Cat",
          rank: 1,
          createdAtMs: T_OLDEST,
        }),
        tok({
          mint: "ScannedMint",
          displayName: "Karat Life Companion",
          rank: 2,
          createdAtMs: T_OG,
        }),
      ]),
      "ScannedMint"
    );
    const all = rows(lib);
    expect(all).toHaveLength(1);
    expect(all[0].name_skeleton).toBe("karat life companion");
    expect(all[0].og_mint).toBe("ScannedMint");
  });
});
