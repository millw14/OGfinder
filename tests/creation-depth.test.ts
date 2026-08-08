import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  canonicalAge,
  selectAgeEscalationTargets,
  type AgeBaseline,
} from "@/lib/enrich-results";
import {
  DEEP_SIG_PAGES,
  MAX_SIG_PAGES,
  MAX_DEEP_ESCALATIONS,
  type TokenResult,
} from "@/lib/types";

/**
 * Creation-date resolution depth.
 *
 * The regression this pins: an ACTIVE token whose signature history is deeper
 * than the cheap page budget was dated by "the oldest signature we happened to
 * reach", which is a LOWER BOUND, not a creation time. COPEPE
 * (Erb3CTbFpQKAgaWRBksBD3uNBdhNQ33X1eA5sue7bAiz) reaches its first transaction
 * at page 12 / 11,266 signatures — measured on mainnet 2026-08-08, first
 * blockTime 1708178206 (2024-02-17T13:56:46Z). At 5 pages the app reported
 * 2025-08-29: eighteen months too recent, and it lost the crown because of it.
 */

// ————————————————————————— fake signature chain —————————————————————————

const PAGE = 1000;

interface FakeChain {
  /** Total signatures on the address, newest first. */
  total: number;
}

/** Newest-first index → deterministic signature/slot/blockTime. */
function sigAt(addr: string, i: number) {
  return {
    signature: `${addr}-sig-${i}`,
    slot: 400_000_000 - i,
    blockTime: 1_800_000_000 - i,
  };
}

let chains: Map<string, FakeChain>;
let rpcCalls: { method: string; address?: string; before?: string }[];

/** Stub global fetch with a getSignaturesForAddress server over `chains`. */
function installFakeRpc() {
  chains = new Map();
  rpcCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const method = body.method as string;
      const params = body.params as [string, { limit: number; before?: string }];
      const address = params?.[0];
      const before = params?.[1]?.before;
      rpcCalls.push({ method, address, before });

      if (method !== "getSignaturesForAddress") {
        return jsonResponse({ result: null });
      }
      const chain = chains.get(address);
      if (!chain) return jsonResponse({ result: [] });

      let start = 0;
      if (before) {
        const idx = Number(before.slice(`${address}-sig-`.length));
        if (!Number.isFinite(idx)) return jsonResponse({ result: [] });
        start = idx + 1;
      }
      const end = Math.min(chain.total, start + PAGE);
      const out = [];
      for (let i = start; i < end; i++) out.push(sigAt(address, i));
      return jsonResponse({ result: out });
    })
  );
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
  } as unknown as Response;
}

/** Fresh module graph + in-memory DB — cache/store hold singletons. */
async function freshLibs() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  process.env.HELIUS_API_KEY = "test-key";
  const helius = await import("@/lib/helius");
  const store = await import("@/lib/store");
  return { helius, store };
}

const DEEP = "Erb3CTbFpQKAgaWRBksBD3uNBdhNQ33X1eA5sue7bAiz";
/** 11,266 signatures = 12 pages — the measured mainnet depth of COPEPE. */
const DEEP_TOTAL = 11266;
const SHALLOW = "Q32DNrAFDCXJQy7q8CNrmJyV2BVvgeWbPhbwVcypump";

beforeEach(() => {
  installFakeRpc();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sigPageCount() {
  return rpcCalls.filter((c) => c.method === "getSignaturesForAddress").length;
}

// ————————————————————————— budget + truncation —————————————————————————

describe("getCreationSlot budgets", () => {
  it("cheap budget truncates a deep history and never serves it as a date", async () => {
    const { helius, store } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });

    const res = await helius.getCreationSlot(DEEP);
    expect(res).not.toBeNull();
    expect(res!.truncated).toBe(true);
    expect(sigPageCount()).toBe(MAX_SIG_PAGES);
    // The bound is the 5,000th signature — NOT the first transaction.
    expect(res!.blockTime).toBe(sigAt(DEEP, MAX_SIG_PAGES * PAGE - 1).blockTime);

    // An incomplete walk is not an answer: the verified-fact reader sees nothing.
    expect(store.getCreationSlotPersisted(DEEP)).toBeUndefined();
  });

  it("records the resume point of an incomplete walk as progress only", async () => {
    const { helius, store } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    await helius.getCreationSlot(DEEP);

    const progress = store.getCreationProgress(DEEP);
    expect(progress).toBeDefined();
    expect(progress!.verifiedComplete).toBe(false);
    expect(progress!.pagesWalked).toBe(MAX_SIG_PAGES);
    expect(progress!.deepestSig).toBe(
      sigAt(DEEP, MAX_SIG_PAGES * PAGE - 1).signature
    );
    expect(progress!.deepestBlockTime).toBe(
      sigAt(DEEP, MAX_SIG_PAGES * PAGE - 1).blockTime
    );
  });

  it("a complete cheap walk is a finished fact, cached and served", async () => {
    const { helius, store } = await freshLibs();
    chains.set(SHALLOW, { total: 307 });

    const res = await helius.getCreationSlot(SHALLOW);
    expect(res!.truncated).toBe(false);
    expect(res!.blockTime).toBe(sigAt(SHALLOW, 306).blockTime);
    expect(store.getCreationSlotPersisted(SHALLOW)).toEqual({
      slot: sigAt(SHALLOW, 306).slot,
      blockTime: sigAt(SHALLOW, 306).blockTime,
    });

    // Reused from cache — no further RPC.
    const before = sigPageCount();
    const again = await helius.getCreationSlot(SHALLOW);
    expect(again!.blockTime).toBe(res!.blockTime);
    expect(sigPageCount()).toBe(before);
  });

  it("the deep budget resolves the depth the cheap budget cannot", async () => {
    const { helius, store } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });

    const res = await helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
    });
    expect(res!.truncated).toBe(false);
    expect(res!.blockTime).toBe(sigAt(DEEP, DEEP_TOTAL - 1).blockTime);
    expect(res!.pagesWalked).toBe(12);
    expect(store.getCreationSlotPersisted(DEEP)).toEqual({
      slot: sigAt(DEEP, DEEP_TOTAL - 1).slot,
      blockTime: sigAt(DEEP, DEEP_TOTAL - 1).blockTime,
    });
  });

  it("DEEP_SIG_PAGES clears the reported case with real headroom", () => {
    expect(DEEP_SIG_PAGES).toBeGreaterThan(12);
    expect(DEEP_SIG_PAGES).toBeGreaterThan(MAX_SIG_PAGES);
  });
});

// ————————————————————————————— resumption —————————————————————————————

describe("resumable pagination", () => {
  it("a resumed deep scan reaches the same answer as a cold full walk", async () => {
    // Cold reference: one uninterrupted deep walk.
    const cold = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    const coldRes = await cold.helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
    });
    const coldPages = sigPageCount();

    // Resumed: a cheap pass first, then a deep pass that continues from it.
    installFakeRpc();
    const warm = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    const cheap = await warm.helius.getCreationSlot(DEEP);
    expect(cheap!.truncated).toBe(true);
    const pagesAfterCheap = sigPageCount();

    const deep = await warm.helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
    });

    expect(deep!.truncated).toBe(false);
    expect(deep!.blockTime).toBe(coldRes!.blockTime);
    expect(deep!.slot).toBe(coldRes!.slot);
    expect(deep!.signature).toBe(coldRes!.signature);
    // Cumulative page accounting matches the cold walk...
    expect(deep!.pagesWalked).toBe(coldRes!.pagesWalked);
    // ...and the resume did NOT re-walk the pages the cheap pass already paid.
    expect(sigPageCount() - pagesAfterCheap).toBe(coldPages - MAX_SIG_PAGES);
    // First resumed request continued from the persisted deepest signature.
    expect(rpcCalls[pagesAfterCheap].before).toBe(cheap!.signature);
  });

  it("an explicit resumeFrom continues from that signature", async () => {
    const { helius } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    const resumeFrom = sigAt(DEEP, 9_999).signature;

    const res = await helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
      resumeFrom,
    });
    expect(rpcCalls[0].before).toBe(resumeFrom);
    expect(res!.truncated).toBe(false);
    expect(res!.blockTime).toBe(sigAt(DEEP, DEEP_TOTAL - 1).blockTime);
    // 10,000 already behind us → only the remaining 2 pages.
    expect(sigPageCount()).toBe(2);
  });

  it("an empty resumed page means the resume point WAS the first transaction", async () => {
    const { helius } = await freshLibs();
    // Exactly 5 full pages: the cheap walk ends on a full page (truncated),
    // and the next page is empty.
    chains.set(DEEP, { total: MAX_SIG_PAGES * PAGE });

    const cheap = await helius.getCreationSlot(DEEP);
    expect(cheap!.truncated).toBe(true);

    const deep = await helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
    });
    expect(deep!.truncated).toBe(false);
    // The seeded resume point is the answer — not lost to the empty page.
    expect(deep!.blockTime).toBe(cheap!.blockTime);
    expect(deep!.signature).toBe(cheap!.signature);
  });

  it("a completed deep walk persists and is reused with no further RPC", async () => {
    const { helius, store } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    await helius.getCreationSlot(DEEP, { maxPages: DEEP_SIG_PAGES });
    const spent = sigPageCount();

    const again = await helius.getCreationSlot(DEEP, {
      maxPages: DEEP_SIG_PAGES,
    });
    expect(sigPageCount()).toBe(spent);
    expect(again!.truncated).toBe(false);
    expect(again!.blockTime).toBe(sigAt(DEEP, DEEP_TOTAL - 1).blockTime);

    // Completion clears the resume bookkeeping — there is no unfinished walk.
    const progress = store.getCreationProgress(DEEP);
    expect(progress!.verifiedComplete).toBe(true);
    expect(progress!.deepestSig).toBeNull();
  });

  it("the cheap bulk pass does not resume — deep budget owns that decision", async () => {
    const { helius } = await freshLibs();
    chains.set(DEEP, { total: DEEP_TOTAL });
    await helius.getCreationSlot(DEEP);
    const first = sigPageCount();

    await helius.getCreationSlot(DEEP);
    // A second cheap pass re-walks from the top rather than burning the bulk
    // budget chasing one token deeper.
    expect(sigPageCount()).toBe(first * 2);
    expect(rpcCalls[first].before).toBeUndefined();
  });

  it("a still-truncated deep walk advances progress for the next attempt", async () => {
    const { helius, store } = await freshLibs();
    chains.set(DEEP, { total: 500_000 });

    const res = await helius.getCreationSlot(DEEP, { maxPages: 7 });
    expect(res!.truncated).toBe(true);
    expect(store.getCreationSlotPersisted(DEEP)).toBeUndefined();
    expect(store.getCreationProgress(DEEP)!.pagesWalked).toBe(7);

    const res2 = await helius.getCreationSlot(DEEP, { maxPages: 7 });
    expect(res2!.truncated).toBe(true);
    expect(store.getCreationProgress(DEEP)!.pagesWalked).toBe(14);
    // Strictly deeper than the first attempt — progress, not repetition.
    expect(res2!.blockTime).toBeLessThan(res!.blockTime);
  });

  it("walkToOldestSignature stops at the deadline and reports truncated", async () => {
    const { helius } = await freshLibs();
    chains.set(DEEP, { total: 500_000 });

    const out = await helius.walkToOldestSignature(DEEP, {
      maxPages: 50,
      deadlineMs: Date.now() - 1,
    });
    // The deadline is checked BEFORE each additional page, so one page always
    // runs — we never return "no data" just because we started late.
    expect(out!.pagesWalked).toBe(1);
    expect(out!.truncated).toBe(true);
  });
});

// ————————————————————————— never served as final —————————————————————————

describe("incomplete walks are never final", () => {
  it("progress rows are invisible to getCreationSlotPersisted", async () => {
    const { store } = await freshLibs();
    store.setCreationProgressPersisted("MintAAA", {
      slot: 10,
      blockTime: 1_700_000_000,
      deepestSig: "sig-deep",
      pagesWalked: 5,
    });
    expect(store.getCreationSlotPersisted("MintAAA")).toBeUndefined();
    expect(store.getCreationProgress("MintAAA")).toMatchObject({
      slot: 10,
      blockTime: 1_700_000_000,
      deepestSig: "sig-deep",
      pagesWalked: 5,
      verifiedComplete: false,
    });
  });

  it("progress can never overwrite or downgrade a completed fact", async () => {
    const { store } = await freshLibs();
    store.setCreationSlotPersisted("MintBBB", {
      slot: 42,
      blockTime: 1_600_000_000,
    });
    store.setCreationProgressPersisted("MintBBB", {
      slot: 999,
      blockTime: 1_799_999_999,
      deepestSig: "sig-late",
      pagesWalked: 40,
    });
    expect(store.getCreationSlotPersisted("MintBBB")).toEqual({
      slot: 42,
      blockTime: 1_600_000_000,
    });
    expect(store.getCreationProgress("MintBBB")!.verifiedComplete).toBe(true);
  });

  it("completing a walk preserves the deployer already on the row", async () => {
    const { store } = await freshLibs();
    store.setCreationProgressPersisted("MintCCC", {
      slot: 5,
      blockTime: 1_700_000_000,
      deepestSig: "sig-x",
      pagesWalked: 5,
    });
    store.setDeployerPersisted("MintCCC", "Dev111", {
      slot: 5,
      blockTime: 1_700_000_000,
    });
    store.setCreationSlotPersisted("MintCCC", {
      slot: 1,
      blockTime: 1_500_000_000,
    });
    expect(store.getDeployerPersisted("MintCCC")).toBe("Dev111");
    expect(store.getCreationSlotPersisted("MintCCC")).toEqual({
      slot: 1,
      blockTime: 1_500_000_000,
    });
  });
});

// ——————————————————————————— canonical merge ———————————————————————————

const NO_TIME: AgeBaseline = {
  createdAtMs: null,
  slot: null,
  timeSource: "unknown",
};

describe("canonicalAge", () => {
  it("marks the result a lower bound only when the truncated walk WON", () => {
    const won = canonicalAge(NO_TIME, {
      slot: 1,
      blockTime: 1_700_000_000,
      truncated: true,
    });
    expect(won.createdAtIsLowerBound).toBe(true);
    expect(won.timeSource).toBe("signatures");

    // An older exact DAS date beats the truncated bound — the walk told us
    // nothing, so it must not taint the result with uncertainty.
    const lost = canonicalAge(
      {
        createdAtMs: 1_600_000_000_000,
        slot: 9,
        timeSource: "helius",
      },
      { slot: 1, blockTime: 1_700_000_000, truncated: true }
    );
    expect(lost.createdAtIsLowerBound).toBe(false);
    expect(lost.timeSource).toBe("helius");
    expect(lost.createdAtMs).toBe(1_600_000_000_000);
  });

  it("an improved deep walk clears the earlier lower bound", () => {
    const bound = canonicalAge(NO_TIME, {
      slot: 1,
      blockTime: 1_756_454_852, // 2025-08-29, the wrong answer
      truncated: true,
    });
    expect(bound.createdAtIsLowerBound).toBe(true);

    const resolved = canonicalAge(NO_TIME, {
      slot: 248_746_616,
      blockTime: 1_708_178_206, // 2024-02-17, the true first transaction
      truncated: false,
    });
    expect(resolved.createdAtIsLowerBound).toBe(false);
    expect(resolved.createdAtMs).toBe(1_708_178_206_000);
    expect(resolved.createdAtMs!).toBeLessThan(bound.createdAtMs!);
  });

  it("a missing walk leaves the metadata baseline untouched", () => {
    const base: AgeBaseline = {
      createdAtMs: 1_650_000_000_000,
      slot: 7,
      timeSource: "dexscreener",
    };
    expect(canonicalAge(base, null)).toEqual({
      ...base,
      createdAtIsLowerBound: false,
    });
  });
});

// ————————————————————————— escalation selection —————————————————————————

function tok(p: Partial<TokenResult> & { mint: string }): TokenResult {
  return {
    displayName: "T",
    displaySymbol: "T",
    slot: null,
    createdAtMs: null,
    createdAt: null,
    dexId: null,
    confidence: 0,
    confidenceLabel: "",
    rank: 0,
    rankLabel: "",
    timeSource: "signatures",
    ...p,
  } as TokenResult;
}

const T = (iso: string) => Date.parse(iso);

describe("selectAgeEscalationTargets", () => {
  it("picks the truncated tokens ranked BELOW the leader — the ambiguous ones", () => {
    // Exactly the reported cohort: an exact-dated leader and a truncated token
    // whose bound is newer. Their true order is UNKNOWABLE without a deep walk.
    const leader = tok({ mint: "A", createdAtMs: T("2025-05-25T00:00:00Z") });
    const truncated = tok({
      mint: "B",
      createdAtMs: T("2025-08-29T00:00:00Z"),
      createdAtIsLowerBound: true,
    });
    const { targets, ambiguousTotal, droppedByCap } =
      selectAgeEscalationTargets([leader, truncated], undefined);
    expect(targets).toEqual(["B"]);
    expect(ambiguousTotal).toBe(1);
    expect(droppedByCap).toBe(0);
  });

  it("always escalates the leader and the scanned mint when their age is a bound", () => {
    const leader = tok({
      mint: "L",
      createdAtMs: T("2024-01-01T00:00:00Z"),
      createdAtIsLowerBound: true,
    });
    const mid = tok({ mint: "M", createdAtMs: T("2024-06-01T00:00:00Z") });
    const scanned = tok({
      mint: "S",
      createdAtMs: T("2025-01-01T00:00:00Z"),
      createdAtIsLowerBound: true,
      isScanned: true,
    });
    const { targets } = selectAgeEscalationTargets([leader, mid, scanned], "S");
    expect(targets.slice(0, 2)).toEqual(["L", "S"]);
    expect(targets).toHaveLength(2);
  });

  it("never spends budget on a token whose date is already exact", () => {
    const leader = tok({ mint: "L", createdAtMs: T("2024-01-01T00:00:00Z") });
    const scanned = tok({ mint: "S", createdAtMs: T("2025-01-01T00:00:00Z") });
    const { targets, ambiguousTotal } = selectAgeEscalationTargets(
      [leader, scanned],
      "S"
    );
    expect(targets).toEqual([]);
    expect(ambiguousTotal).toBe(0);
  });

  it("caps the ambiguous set by liquidity/market cap and reports the overflow", () => {
    const leader = tok({ mint: "L", createdAtMs: T("2020-01-01T00:00:00Z") });
    const dust = Array.from({ length: 10 }, (_, i) =>
      tok({
        mint: `D${i}`,
        createdAtMs: T("2024-01-01T00:00:00Z") + i,
        createdAtIsLowerBound: true,
        liquidityUsd: i, // 0..9 — biggest liquidity wins the budget
      })
    );
    const { targets, ambiguousTotal, droppedByCap } =
      selectAgeEscalationTargets([leader, ...dust], undefined);

    expect(ambiguousTotal).toBe(10);
    expect(targets).toHaveLength(MAX_DEEP_ESCALATIONS);
    expect(droppedByCap).toBe(10 - MAX_DEEP_ESCALATIONS);
    expect(targets).toEqual(["D9", "D8", "D7", "D6", "D5", "D4"]);
  });

  it("falls back to market cap, then FDV, when liquidity is absent", () => {
    const leader = tok({ mint: "L", createdAtMs: T("2020-01-01T00:00:00Z") });
    const byMc = tok({
      mint: "MC",
      createdAtMs: T("2024-01-01T00:00:00Z"),
      createdAtIsLowerBound: true,
      marketCapUsd: 5_000_000,
    });
    const byFdv = tok({
      mint: "FDV",
      createdAtMs: T("2024-01-02T00:00:00Z"),
      createdAtIsLowerBound: true,
      fdvUsd: 900_000,
    });
    const nothing = tok({
      mint: "NIL",
      createdAtMs: T("2024-01-03T00:00:00Z"),
      createdAtIsLowerBound: true,
    });
    const { targets } = selectAgeEscalationTargets(
      [leader, nothing, byFdv, byMc],
      undefined,
      2
    );
    expect(targets).toEqual(["MC", "FDV"]);
  });

  it("counts a capped-out ambiguous set even when the always-set is full", () => {
    const leader = tok({
      mint: "L",
      createdAtMs: T("2024-01-01T00:00:00Z"),
      createdAtIsLowerBound: true,
    });
    const others = Array.from({ length: 3 }, (_, i) =>
      tok({
        mint: `O${i}`,
        createdAtMs: T("2025-01-01T00:00:00Z") + i,
        createdAtIsLowerBound: true,
        liquidityUsd: i,
      })
    );
    const { targets, ambiguousTotal, droppedByCap } =
      selectAgeEscalationTargets([leader, ...others], undefined, 1);
    expect(targets).toEqual(["L", "O2"]);
    expect(ambiguousTotal).toBe(3);
    expect(droppedByCap).toBe(2);
  });

  it("handles a cohort with no usable times at all", () => {
    const a = tok({ mint: "A" });
    const b = tok({ mint: "B" });
    expect(selectAgeEscalationTargets([a, b], "B")).toEqual({
      targets: [],
      ambiguousTotal: 0,
      droppedByCap: 0,
    });
  });
});
