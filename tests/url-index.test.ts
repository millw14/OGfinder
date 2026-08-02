import { describe, it, expect, beforeEach, vi } from "vitest";

/** Fresh in-memory DB per test — the module holds a connection singleton. */
async function freshUrlIndex() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  return import("@/lib/url-index");
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

describe("url-index", () => {
  it("matches exact and slash-boundary prefixes, not partial segments", async () => {
    const idx = await freshUrlIndex();
    idx.upsertTokenLinks("MintFoo", ["https://x.com/foo"], "test");

    expect(idx.searchByUrl(["x.com/foo"])).toEqual(["MintFoo"]);
    // Reverse prefix: a deeper target still matches the stored profile URL.
    expect(idx.searchByUrl(["x.com/foo/status"])).toEqual(["MintFoo"]);
    // Partial segment must NOT match.
    expect(idx.searchByUrl(["x.com/foobar"])).toEqual([]);
  });

  it("never lets stored URLs act as LIKE wildcards", async () => {
    const idx = await freshUrlIndex();
    idx.upsertTokenLinks("MintEvil", ["https://evil.com/a%b"], "test");
    idx.upsertTokenLinks("MintEvil2", ["https://evil.com/%"], "test");

    // % in stored data matches only literally, in both directions.
    expect(idx.searchByUrl(["evil.com/axb"])).toEqual([]);
    expect(idx.searchByUrl(["evil.com/anything"])).toEqual([]);
    expect(idx.searchByUrl(["evil.com/a%b"])).toEqual(["MintEvil"]);
  });

  it("skips bare-host URLs on upsert", async () => {
    const idx = await freshUrlIndex();
    idx.upsertTokenLinks("MintBare", ["https://x.com"], "test");
    expect(idx.searchByUrl(["x.com"])).toEqual([]);
  });

  it("tracks verification: verified upserts refresh last_verified_at, plain ones preserve it", async () => {
    const idx = await freshUrlIndex();
    const url = "https://x.com/verifycase";

    idx.upsertTokenLinks("MintV", [url], "test");
    let hits = idx.searchByUrlDetailed(["x.com/verifycase"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].lastVerifiedAt).toBeNull();

    idx.upsertTokenLinks("MintV", [url], "test", { verified: true });
    hits = idx.searchByUrlDetailed(["x.com/verifycase"]);
    expect(hits[0].lastVerifiedAt).not.toBeNull();
    const verifiedAt = hits[0].lastVerifiedAt;

    // Plain re-upsert must not clear verification.
    idx.upsertTokenLinks("MintV", [url], "test");
    hits = idx.searchByUrlDetailed(["x.com/verifycase"]);
    expect(hits[0].lastVerifiedAt).toBe(verifiedAt);
  });

  it("keeps first-seen discovered_at and source across re-upserts", async () => {
    const idx = await freshUrlIndex();
    const url = "https://x.com/firstseen";

    idx.upsertTokenLinks("MintF", [url], "sourceA");
    const before = idx
      .getDb()
      .prepare("SELECT discovered_at, source, last_seen_at FROM token_links WHERE mint = ?")
      .get("MintF") as { discovered_at: number; source: string; last_seen_at: number };

    idx.upsertTokenLinks("MintF", [url], "sourceB");
    const after = idx
      .getDb()
      .prepare("SELECT discovered_at, source, last_seen_at FROM token_links WHERE mint = ?")
      .get("MintF") as { discovered_at: number; source: string; last_seen_at: number };

    expect(after.discovered_at).toBe(before.discovered_at);
    expect(after.source).toBe("sourceA");
    expect(after.last_seen_at).toBeGreaterThanOrEqual(before.last_seen_at);
  });
});
