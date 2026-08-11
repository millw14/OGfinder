import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isSafeImageUrl,
  isSafeFetchUrl,
  pickDasImageUrl,
  parseDasAsset,
  parseOffchainTokenMeta,
} from "@/lib/helius";
import { resolveTokenImage } from "@/lib/enrich-results";

/**
 * Token media + metadata captured from the DAS getAssetBatch response we
 * already pay for. Shapes below are the ones verified live against mainnet on
 * 2026-08-11 (BONK and pump.fun-era mints) — see parseDasAsset's doc comment.
 */

describe("isSafeImageUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isSafeImageUrl("https://arweave.net/hQiPZOsRZXGXBJd")).toBe(true);
    expect(
      isSafeImageUrl(
        "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/x"
      )
    ).toBe(true);
    expect(isSafeImageUrl("http://example.com/logo.png")).toBe(true);
    // Protocol comparison is case-insensitive via URL normalization.
    expect(isSafeImageUrl("HTTPS://example.com/logo.png")).toBe(true);
    // Surrounding whitespace is tolerated, not a rejection.
    expect(isSafeImageUrl("  https://example.com/logo.png  ")).toBe(true);
  });

  it("rejects data: URLs (unbounded payload smuggled through metadata)", () => {
    expect(
      isSafeImageUrl("data:image/svg+xml;base64,PHN2ZyB4bWxucz0i")
    ).toBe(false);
    expect(isSafeImageUrl("  DATA:image/png;base64,AAAA")).toBe(false);
  });

  it("rejects javascript: URLs (script injection via an href)", () => {
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("  javascript:alert(document.cookie)")).toBe(false);
    expect(isSafeImageUrl("JaVaScRiPt:alert(1)")).toBe(false);
  });

  it("rejects non-browser-fetchable schemes", () => {
    expect(isSafeImageUrl("ipfs://bafkreicnd2cr64sci4rn4smibwjith")).toBe(false);
    expect(isSafeImageUrl("ar://QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u")).toBe(
      false
    );
    expect(isSafeImageUrl("file:///C:/Windows/System32/drivers/etc/hosts")).toBe(
      false
    );
  });

  it("rejects relative and protocol-relative URLs (they'd resolve to OUR origin)", () => {
    expect(isSafeImageUrl("/logo.png")).toBe(false);
    expect(isSafeImageUrl("./logo.png")).toBe(false);
    expect(isSafeImageUrl("logo.png")).toBe(false);
    expect(isSafeImageUrl("//evil.example.com/logo.png")).toBe(false);
  });

  it("rejects empty, whitespace-only, non-string and over-long values", () => {
    expect(isSafeImageUrl("")).toBe(false);
    expect(isSafeImageUrl("   ")).toBe(false);
    expect(isSafeImageUrl(undefined)).toBe(false);
    expect(isSafeImageUrl(null)).toBe(false);
    expect(isSafeImageUrl(42)).toBe(false);
    expect(isSafeImageUrl({ url: "https://example.com" })).toBe(false);
    expect(isSafeImageUrl(`https://example.com/${"a".repeat(2100)}`)).toBe(
      false
    );
  });
});

describe("isSafeFetchUrl (SSRF guard for server-side json_uri fetches)", () => {
  it("accepts ordinary public metadata hosts", () => {
    expect(isSafeFetchUrl("https://ipfs.io/ipfs/bafkreidaggjqdcjq57")).toBe(
      true
    );
    expect(isSafeFetchUrl("https://arweave.net/QPC6FYdUn-3V8ytFNuo")).toBe(true);
  });

  it("rejects loopback, private and link-local hosts", () => {
    expect(isSafeFetchUrl("http://localhost:3400/api/search")).toBe(false);
    expect(isSafeFetchUrl("http://127.0.0.1/x")).toBe(false);
    expect(isSafeFetchUrl("http://0.0.0.0/x")).toBe(false);
    expect(isSafeFetchUrl("http://10.0.0.5/x")).toBe(false);
    expect(isSafeFetchUrl("http://192.168.1.1/x")).toBe(false);
    expect(isSafeFetchUrl("http://172.16.0.9/x")).toBe(false);
    expect(isSafeFetchUrl("http://172.31.255.255/x")).toBe(false);
    // Cloud instance-metadata endpoint — the classic SSRF target.
    expect(isSafeFetchUrl("http://169.254.169.254/latest/meta-data/")).toBe(
      false
    );
    expect(isSafeFetchUrl("http://[::1]:8080/x")).toBe(false);
  });

  it("does not over-reject public addresses that merely look adjacent", () => {
    expect(isSafeFetchUrl("http://172.32.0.1/x")).toBe(true);
    expect(isSafeFetchUrl("http://172.15.0.1/x")).toBe(true);
    expect(isSafeFetchUrl("http://11.0.0.1/x")).toBe(true);
  });
});

describe("pickDasImageUrl", () => {
  // Exactly BONK's content block, from a live getAsset on 2026-08-11.
  const BONK_CONTENT = {
    json_uri: "https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw",
    links: {
      image: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
    },
    files: [
      {
        uri: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
        cdn_uri:
          "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
        mime: "image/png",
      },
    ],
  };

  it("prefers the Helius CDN copy — resized, and it proxies the arbitrary host", () => {
    expect(pickDasImageUrl(BONK_CONTENT)).toBe(BONK_CONTENT.files[0].cdn_uri);
  });

  it("falls back to links.image when no file carries a cdn_uri", () => {
    expect(
      pickDasImageUrl({
        links: { image: "https://arweave.net/img" },
        files: [{ uri: "https://arweave.net/img", mime: "image/png" }],
      })
    ).toBe("https://arweave.net/img");
  });

  it("falls back to files[].uri when links.image is missing", () => {
    expect(
      pickDasImageUrl({ files: [{ uri: "https://ipfs.io/ipfs/bafy" }] })
    ).toBe("https://ipfs.io/ipfs/bafy");
  });

  it("skips files whose mime is not an image", () => {
    expect(
      pickDasImageUrl({
        files: [
          { cdn_uri: "https://cdn.example.com/clip.mp4", mime: "video/mp4" },
          { cdn_uri: "https://cdn.example.com/logo.png", mime: "image/png" },
        ],
      })
    ).toBe("https://cdn.example.com/logo.png");
  });

  it("skips unsafe candidates instead of blanking the token", () => {
    expect(
      pickDasImageUrl({
        files: [{ cdn_uri: "javascript:alert(1)", mime: "image/png" }],
        links: { image: "data:image/svg+xml;base64,AAAA" },
      })
    ).toBeUndefined();

    // The unsafe CDN entry must not shadow the usable raw URI.
    expect(
      pickDasImageUrl({
        files: [
          { cdn_uri: "ipfs://bafy", uri: "https://ipfs.io/ipfs/bafy" },
        ],
      })
    ).toBe("https://ipfs.io/ipfs/bafy");
  });

  it("returns undefined for content with no image at all", () => {
    expect(pickDasImageUrl(undefined)).toBeUndefined();
    expect(pickDasImageUrl({})).toBeUndefined();
    expect(pickDasImageUrl({ files: [] })).toBeUndefined();
  });
});

describe("parseDasAsset", () => {
  /** Verbatim shape of the live BONK getAsset response (2026-08-11). */
  const BONK = {
    id: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    interface: "FungibleToken",
    content: {
      json_uri:
        "https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw",
      links: {
        image: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
      },
      files: [
        {
          uri: "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
          cdn_uri:
            "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
          mime: "image/png",
        },
      ],
      metadata: {
        description: "The Official Bonk Inu token",
        json_name: "Bonk",
        name: "Bonk",
        symbol: "Bonk",
        token_standard: "Fungible",
      },
    },
    authorities: [
      {
        address: "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw",
        scopes: ["full"],
      },
    ],
    token_info: {
      symbol: "Bonk",
      supply: 8799458988338050000,
      decimals: 5,
      token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
    mutable: true,
    burnt: false,
  };

  it("captures media + metadata alongside the existing age/authority fields", () => {
    const data = parseDasAsset(BONK);
    expect(data.heliusName).toBe("Bonk");
    expect(data.heliusSymbol).toBe("Bonk");
    expect(data.tokenInterface).toBe("FungibleToken");
    expect(data.supply).toBe(8799458988338050000);
    expect(data.imageUrl).toBe(BONK.content.files[0].cdn_uri);
    expect(data.description).toBe("The Official Bonk Inu token");
    expect(data.tokenStandard).toBe("Fungible");
    expect(data.decimals).toBe(5);
    expect(data.updateAuthority).toBe(
      "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw"
    );
    expect(data.burnt).toBe(false);
    expect(data.jsonUri).toBe(BONK.content.json_uri);
    expect(data.metadataMutable).toBe(true);
  });

  it("keeps the existing authority semantics (omitted key = revoked)", () => {
    const data = parseDasAsset(BONK);
    // BONK's token_info reports neither authority → both revoked.
    expect(data.mintAuthorityActive).toBe(false);
    expect(data.freezeAuthorityActive).toBe(false);

    const live = parseDasAsset({
      ...BONK,
      token_info: { ...BONK.token_info, mint_authority: "So1111" },
    });
    expect(live.mintAuthorityActive).toBe(true);
  });

  it("omits fields DAS did not report rather than inventing empties", () => {
    // A bare Token-2022 pump mint: empty description, no token_standard, no authorities.
    const data = parseDasAsset({
      id: "HEbUvkbywvff12bmGSzfAGX8vF5ANykzyQnFvxvppump",
      interface: "FungibleToken",
      content: {
        json_uri: "https://ipfs.io/ipfs/bafkreidaggjqdcjq57hbtlwfcryjxdc4",
        metadata: { description: "", name: "PUMP", symbol: "PUMP" },
      },
      authorities: [],
      token_info: { supply: 2000000000000000, decimals: 6 },
    });
    expect(data).not.toHaveProperty("description");
    expect(data).not.toHaveProperty("tokenStandard");
    expect(data).not.toHaveProperty("updateAuthority");
    expect(data).not.toHaveProperty("imageUrl");
    expect(data).not.toHaveProperty("burnt");
    expect(data.decimals).toBe(6);
    expect(data.jsonUri).toBe("https://ipfs.io/ipfs/bafkreidaggjqdcjq57hbtlwfcryjxdc4");
  });

  it("truncates a long description without splitting an emoji surrogate pair", () => {
    // 499 chars then a 2-code-unit emoji: the naive slice(0,500) would keep a
    // lone high surrogate, which renders as a replacement character.
    const description = "a".repeat(499) + "🐕" + "tail";
    const data = parseDasAsset({
      ...BONK,
      content: { ...BONK.content, metadata: { ...BONK.content.metadata, description } },
    });
    expect(data.description).toBe("a".repeat(499));
    // No unpaired surrogate survived the cut.
    expect(data.description).toBe(data.description!.toWellFormed());
  });

  it("ignores authorities that are not scoped 'full'", () => {
    const data = parseDasAsset({
      ...BONK,
      authorities: [{ address: "Partial111", scopes: ["metadata"] }],
    });
    expect(data).not.toHaveProperty("updateAuthority");
  });

  it("refuses an unsafe json_uri so it is never fetched or rendered", () => {
    const data = parseDasAsset({
      ...BONK,
      content: { ...BONK.content, json_uri: "javascript:alert(1)" },
    });
    expect(data).not.toHaveProperty("jsonUri");
  });
});

describe("resolveTokenImage (the fallback chain)", () => {
  const DEX = "https://dd.dexscreener.com/ds-data/tokens/solana/abc.png";
  const DAS = "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/x";

  it("prefers the DexScreener market logo when there is one", () => {
    expect(resolveTokenImage(DEX, DAS)).toEqual({
      imageUrl: DEX,
      imageSource: "dexscreener",
    });
  });

  it("falls back to the DAS image — the case that lights up most of a cohort", () => {
    expect(resolveTokenImage(undefined, DAS)).toEqual({
      imageUrl: DAS,
      imageSource: "das",
    });
    expect(resolveTokenImage(null, DAS)).toEqual({
      imageUrl: DAS,
      imageSource: "das",
    });
  });

  it("returns null when neither source has a usable image", () => {
    expect(resolveTokenImage(undefined, undefined)).toBeNull();
    expect(resolveTokenImage("", "")).toBeNull();
  });

  it("falls through to DAS when the DexScreener value is unusable", () => {
    expect(resolveTokenImage("javascript:alert(1)", DAS)).toEqual({
      imageUrl: DAS,
      imageSource: "das",
    });
    expect(resolveTokenImage("/relative.png", DAS)).toEqual({
      imageUrl: DAS,
      imageSource: "das",
    });
  });

  it("returns null rather than passing an unsafe URL through from either side", () => {
    expect(
      resolveTokenImage("data:image/png;base64,AAAA", "javascript:alert(1)")
    ).toBeNull();
  });
});

describe("parseOffchainTokenMeta", () => {
  it("reads top-level website/twitter/telegram (verified pump.fun shape)", () => {
    expect(
      parseOffchainTokenMeta({
        name: "CAT",
        symbol: "CAT",
        description: "Cat terminal",
        image: "https://ipfs.io/ipfs/bafy",
        showName: true,
        createdOn: "https://pump.fun",
        website: "https://www.cat-terminal.xyz/",
        twitter: "https://x.com/Cat_Terminal_",
        telegram: "https://t.me/catterminal",
      })
    ).toEqual({
      website: "https://www.cat-terminal.xyz/",
      twitter: "https://x.com/Cat_Terminal_",
      telegram: "https://t.me/catterminal",
      description: "Cat terminal",
    });
  });

  it("reads the extensions object when the top level has nothing", () => {
    expect(
      parseOffchainTokenMeta({
        name: "cat",
        symbol: "cot",
        description: "",
        extensions: { twitter: "https://x.com/vldscorpius/status/193243" },
      })
    ).toEqual({ twitter: "https://x.com/vldscorpius/status/193243" });
  });

  it("lets the top level win over extensions", () => {
    expect(
      parseOffchainTokenMeta({
        website: "https://top.example",
        extensions: { website: "https://ext.example" },
      })
    ).toEqual({ website: "https://top.example" });
  });

  it("uses Metaplex external_url as the last website fallback", () => {
    expect(
      parseOffchainTokenMeta({ external_url: "https://project.example" })
    ).toEqual({ website: "https://project.example" });
  });

  it("drops unsafe URLs — a javascript: 'website' never reaches an href", () => {
    expect(
      parseOffchainTokenMeta({
        website: "javascript:alert(1)",
        twitter: "data:text/html,<script>",
        telegram: "//evil.example.com",
      })
    ).toEqual({});
  });

  it("returns an empty object for malformed documents", () => {
    expect(parseOffchainTokenMeta(null)).toEqual({});
    expect(parseOffchainTokenMeta("not json")).toEqual({});
    expect(parseOffchainTokenMeta([1, 2, 3])).toEqual({});
    expect(parseOffchainTokenMeta({ extensions: "nope" })).toEqual({});
  });
});

/**
 * getAssetBatch cache path. A previous regression in this repo served cache
 * hits through a narrower shape, so the second scan of a mint lost its
 * metadata — this pins that the stored HeliusSlotData comes back whole.
 */
describe("getAssetBatch cache hits keep the DAS media fields", () => {
  const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const CDN =
    "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/hQiPZOs";
  const originalKey = process.env.HELIUS_API_KEY;

  const dasResponse = {
    jsonrpc: "2.0",
    id: "ogfinder",
    result: [
      {
        id: MINT,
        interface: "FungibleToken",
        content: {
          json_uri: "https://arweave.net/QPC6FYdUn",
          files: [{ uri: "https://arweave.net/hQiPZOs", cdn_uri: CDN, mime: "image/png" }],
          metadata: {
            description: "The Official Bonk Inu token",
            name: "Bonk",
            symbol: "Bonk",
            token_standard: "Fungible",
          },
        },
        authorities: [
          {
            address: "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw",
            scopes: ["full"],
          },
        ],
        token_info: { supply: 8799458988338050000, decimals: 5 },
        mutable: true,
        burnt: false,
      },
    ],
  };

  beforeEach(() => {
    process.env.HELIUS_API_KEY = "test-key-not-a-real-credential";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (originalKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = originalKey;
  });

  it("serves the second call from cache with every field intact", async () => {
    // Fresh module registry so the NodeCache starts empty for this test.
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(dasResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getAssetBatch } = await import("@/lib/helius");

    const cold = (await getAssetBatch([MINT])).get(MINT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cold?.imageUrl).toBe(CDN);

    const warm = (await getAssetBatch([MINT])).get(MINT);
    // No second network call — this really is the cache path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warm?.imageUrl).toBe(CDN);
    expect(warm?.description).toBe("The Official Bonk Inu token");
    expect(warm?.tokenStandard).toBe("Fungible");
    expect(warm?.decimals).toBe(5);
    expect(warm?.supply).toBe(8799458988338050000);
    expect(warm?.updateAuthority).toBe(
      "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw"
    );
    expect(warm?.burnt).toBe(false);
    expect(warm?.jsonUri).toBe("https://arweave.net/QPC6FYdUn");
    expect(warm).toEqual(cold);
  });
});
