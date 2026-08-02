import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isDeployerProfileFresh,
  DEPLOYER_PROFILE_FRESH_MS,
} from "@/lib/helius";

/**
 * Deployer intelligence: profile-freshness window (pure) and the SQLite
 * persistence layer (deployer_profiles + creation_slots.deployer migration).
 */

describe("isDeployerProfileFresh", () => {
  const NOW = Date.parse("2026-08-02T00:00:00.000Z");

  it("is fresh strictly inside the 24h window, stale at the boundary", () => {
    expect(isDeployerProfileFresh(NOW, NOW)).toBe(true);
    expect(
      isDeployerProfileFresh(NOW - DEPLOYER_PROFILE_FRESH_MS + 1, NOW)
    ).toBe(true);
    // Boundary is exclusive — exactly 24h old means refresh.
    expect(isDeployerProfileFresh(NOW - DEPLOYER_PROFILE_FRESH_MS, NOW)).toBe(
      false
    );
    expect(
      isDeployerProfileFresh(NOW - DEPLOYER_PROFILE_FRESH_MS - 1, NOW)
    ).toBe(false);
  });
});

/** Fresh in-memory DB per test — the modules hold a connection singleton. */
async function freshStore() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  const store = await import("@/lib/store");
  const urlIndex = await import("@/lib/url-index");
  return { ...store, ...urlIndex };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

const MINT = "2DNYnFCx5HXPhTfxpT13PBADeMy4xZXFSqEwUBcTpump";
const DEV = "7cJMTHUnZBZU3R48cobe4FesyRuddaUyCBT7LoPATgLq";

describe("deployer persistence (creation_slots.deployer)", () => {
  it("roundtrips a deployer and only updates the column on existing rows", async () => {
    const lib = await freshStore();
    expect(lib.getDeployerPersisted(MINT)).toBeUndefined();

    // Existing complete creation-slot row keeps its slot/blockTime.
    lib.setCreationSlotPersisted(MINT, { slot: 100, blockTime: 1700000000 });
    lib.setDeployerPersisted(MINT, DEV, { slot: 999, blockTime: 1800000000 });
    expect(lib.getDeployerPersisted(MINT)).toBe(DEV);
    expect(lib.getCreationSlotPersisted(MINT)).toEqual({
      slot: 100,
      blockTime: 1700000000,
    });
  });

  it("inserts a fresh row with the found slot data when none exists", async () => {
    const lib = await freshStore();
    lib.setDeployerPersisted(MINT, DEV, { slot: 42, blockTime: 1750000000 });
    expect(lib.getDeployerPersisted(MINT)).toBe(DEV);
    // A real blockTime doubles as a complete creation-slot fact.
    expect(lib.getCreationSlotPersisted(MINT)).toEqual({
      slot: 42,
      blockTime: 1750000000,
    });
  });

  it("never serves a zero blockTime as a verified creation slot", async () => {
    const lib = await freshStore();
    lib.setDeployerPersisted(MINT, DEV, { slot: 42, blockTime: 0 });
    expect(lib.getDeployerPersisted(MINT)).toBe(DEV);
    expect(lib.getCreationSlotPersisted(MINT)).toBeUndefined();
  });
});

describe("deployer_profiles persistence", () => {
  it("roundtrips a full profile and a nulls-only profile", async () => {
    const lib = await freshStore();
    expect(lib.getDeployerProfilePersisted(DEV)).toBeUndefined();

    const full = {
      tokensCreated: 8,
      walletFirstSeenMs: 1784574317000,
      isOldWallet: false,
      checkedAt: 1785000000000,
    };
    lib.setDeployerProfilePersisted(DEV, full);
    expect(lib.getDeployerProfilePersisted(DEV)).toEqual(full);

    const sparse = {
      tokensCreated: null,
      walletFirstSeenMs: null,
      isOldWallet: true,
      checkedAt: 1785000001000,
    };
    lib.setDeployerProfilePersisted(DEV, sparse);
    expect(lib.getDeployerProfilePersisted(DEV)).toEqual(sparse);
  });
});
