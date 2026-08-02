import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyLinkProvenance,
  provenanceMints,
  MIN_LEAD_MS,
  MAX_PROVENANCE_RANKED,
} from "@/lib/provenance";
import type { MintLinkRow } from "@/lib/url-index";
import type { TokenResult } from "@/lib/types";

/** Minimal TokenResult factory — only the fields provenance reads/writes. */
function make(partial: Partial<TokenResult>): TokenResult {
  return {
    mint: "Mint11111111111111111111111111111111111111",
    displayName: "Token",
    displaySymbol: "TKN",
    slot: null,
    createdAtMs: null,
    createdAt: null,
    dexId: null,
    confidence: 0,
    confidenceLabel: "",
    rank: 0,
    rankLabel: "",
    timeSource: null,
    ...partial,
  } as TokenResult;
}

function row(mint: string, url_norm: string, discovered_at: number): MintLinkRow {
  return { mint, url_norm, discovered_at };
}

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

describe("applyLinkProvenance", () => {
  it("flags the earliest claimant of a contested URL with a 1h+ lead", () => {
    const og = make({ mint: "OGmint" });
    const copy = make({ mint: "CopyMint" });
    applyLinkProvenance(
      [og, copy],
      [
        row("OGmint", "x.com/bonk", T0),
        row("CopyMint", "x.com/bonk", T0 + 2 * HOUR),
      ]
    );

    expect(og.linkProvenance).toEqual({
      url: "x.com/bonk",
      firstSeenMs: T0,
      rivalCount: 1,
      leadMs: 2 * HOUR,
    });
    // Never claim the negative — the later claimant stays untouched.
    expect(copy.linkProvenance).toBeUndefined();
  });

  it("counts all distinct rivals, not just the runner-up", () => {
    const og = make({ mint: "OGmint" });
    applyLinkProvenance(
      [og],
      [
        row("OGmint", "x.com/bonk", T0),
        row("CopyA", "x.com/bonk", T0 + 3 * HOUR),
        row("CopyB", "x.com/bonk", T0 + 5 * HOUR),
      ]
    );
    expect(og.linkProvenance?.rivalCount).toBe(2);
    expect(og.linkProvenance?.leadMs).toBe(3 * HOUR);
  });

  it("does not flag anyone when the lead is under MIN_LEAD_MS", () => {
    const og = make({ mint: "OGmint" });
    const copy = make({ mint: "CopyMint" });
    applyLinkProvenance(
      [og, copy],
      [
        // Near-identical discovered_at = same poll tick / index inception.
        row("OGmint", "x.com/bonk", T0),
        row("CopyMint", "x.com/bonk", T0 + MIN_LEAD_MS - 1),
      ]
    );
    expect(og.linkProvenance).toBeUndefined();
    expect(copy.linkProvenance).toBeUndefined();
  });

  it("flags at exactly MIN_LEAD_MS", () => {
    const og = make({ mint: "OGmint" });
    applyLinkProvenance(
      [og],
      [
        row("OGmint", "x.com/bonk", T0),
        row("CopyMint", "x.com/bonk", T0 + MIN_LEAD_MS),
      ]
    );
    expect(og.linkProvenance?.leadMs).toBe(MIN_LEAD_MS);
  });

  it("ignores single-claimant (uncontested) URLs", () => {
    const og = make({ mint: "OGmint" });
    applyLinkProvenance([og], [row("OGmint", "x.com/solo", T0)]);
    expect(og.linkProvenance).toBeUndefined();
  });

  it("keeps the contested URL with the largest lead per token", () => {
    const og = make({ mint: "OGmint" });
    applyLinkProvenance(
      [og],
      [
        row("OGmint", "x.com/small", T0),
        row("CopyA", "x.com/small", T0 + 2 * HOUR),
        row("OGmint", "x.com/big", T0),
        row("CopyB", "x.com/big", T0 + 9 * HOUR),
      ]
    );
    expect(og.linkProvenance?.url).toBe("x.com/big");
    expect(og.linkProvenance?.leadMs).toBe(9 * HOUR);
  });
});

describe("provenanceMints (cap behavior)", () => {
  it("caps at scanned + first 25 ranked", () => {
    const results = Array.from({ length: 40 }, (_, i) =>
      make({ mint: `Ranked${i}` })
    );
    const mints = provenanceMints(results, "ScannedMint");
    expect(mints).toHaveLength(MAX_PROVENANCE_RANKED + 1);
    expect(mints).toContain("ScannedMint");
    expect(mints).toContain("Ranked0");
    expect(mints).toContain(`Ranked${MAX_PROVENANCE_RANKED - 1}`);
    expect(mints).not.toContain(`Ranked${MAX_PROVENANCE_RANKED}`);
  });

  it("dedupes the scanned mint when it is already ranked", () => {
    const results = [make({ mint: "ScannedMint" }), make({ mint: "Other" })];
    const mints = provenanceMints(results, "ScannedMint");
    expect(mints).toEqual(["ScannedMint", "Other"]);
  });
});

describe("getLinksForMints (cap behavior)", () => {
  beforeEach(() => {
    process.env.OGFINDER_DB_PATH = ":memory:";
  });

  it("only queries the first 30 mints", async () => {
    // Fresh in-memory DB — the module holds a connection singleton.
    vi.resetModules();
    const idx = await import("@/lib/url-index");
    const mints = Array.from({ length: 35 }, (_, i) => `CapMint${i}`);
    for (const m of mints) {
      idx.upsertTokenLinks(m, [`https://x.com/${m.toLowerCase()}`], "test");
    }

    const rows = idx.getLinksForMints(mints);
    const returned = new Set(rows.map((r) => r.mint));
    expect(returned.size).toBe(30);
    expect(returned.has("CapMint29")).toBe(true);
    expect(returned.has("CapMint30")).toBe(false);
  });

  it("returns [] for empty input", async () => {
    vi.resetModules();
    const idx = await import("@/lib/url-index");
    expect(idx.getLinksForMints([])).toEqual([]);
  });
});
