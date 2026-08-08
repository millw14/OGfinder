import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractMintCandidates,
  formatBlockingFlagLine,
  formatDeployerLine,
  formatMintVerdict,
  formatNameSearchReply,
  formatRegistryVerdict,
  formatSafetyRiskChip,
  parseBotCommand,
  verdictShareUrl,
  VerdictCooldown,
} from "@/lib/telegram";
import type { OgRegistryEntry } from "@/lib/og-registry";
import { telegramWatchIpKey } from "@/lib/watches";
import type { MintScanPayload } from "@/lib/scan";
import type { TokenResult } from "@/lib/types";
import { decodeSharePayload } from "@/lib/share";
import { timeAgo, formatAgeGap } from "@/lib/format";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // 44 chars
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // 44 chars
const WSOL = "So11111111111111111111111111111111111111112"; // 43 chars
const SITE = "https://ogfinder.example";

// ————————————————————————— extractMintCandidates —————————————————————————

describe("extractMintCandidates", () => {
  it("extracts multiple mints in order", () => {
    expect(extractMintCandidates(`check ${USDC} vs ${BONK}`)).toEqual([
      USDC,
      BONK,
    ]);
  });

  it("caps candidates (default 2, custom cap respected)", () => {
    const text = `${USDC} ${BONK} ${WSOL}`;
    expect(extractMintCandidates(text)).toEqual([USDC, BONK]);
    expect(extractMintCandidates(text, 3)).toEqual([USDC, BONK, WSOL]);
    expect(extractMintCandidates(text, 1)).toEqual([USDC]);
  });

  it("dedupes repeated mints", () => {
    expect(extractMintCandidates(`${USDC} again ${USDC}`)).toEqual([USDC]);
  });

  it("rejects non-mints: short, long, and non-base58 text", () => {
    expect(extractMintCandidates("gm everyone")).toEqual([]);
    expect(extractMintCandidates("1".repeat(31))).toEqual([]);
    expect(extractMintCandidates("1".repeat(45))).toEqual([]);
    // 0, O, I, l are not base58 — a run containing them can't be one token,
    // but they act as boundaries for an adjacent valid run.
    expect(extractMintCandidates(`0${USDC}`)).toEqual([]);
  });

  it("rejects candidates embedded in longer alphanumeric runs", () => {
    expect(extractMintCandidates(`x${USDC}`)).toEqual([]);
    expect(extractMintCandidates(`${USDC}9`)).toEqual([]);
  });

  it("extracts mints from dexscreener/birdeye/pump.fun URLs", () => {
    expect(
      extractMintCandidates(`https://dexscreener.com/solana/${BONK}?t=1`)
    ).toEqual([BONK]);
    expect(
      extractMintCandidates(`https://birdeye.so/token/${USDC}`)
    ).toEqual([USDC]);
    expect(extractMintCandidates(`https://pump.fun/coin/${BONK}`)).toEqual([
      BONK,
    ]);
  });
});

// ————————————————————————— parseBotCommand —————————————————————————

describe("parseBotCommand", () => {
  it("parses every command, with and without args", () => {
    expect(parseBotCommand(`/og ${USDC}`)).toEqual({
      command: "og",
      mention: null,
      arg: USDC,
    });
    expect(parseBotCommand("/watches")).toEqual({
      command: "watches",
      mention: null,
      arg: null,
    });
    expect(parseBotCommand("/watch")).toEqual({
      command: "watch",
      mention: null,
      arg: null,
    });
    expect(parseBotCommand("/unwatch 12")).toEqual({
      command: "unwatch",
      mention: null,
      arg: "12",
    });
    expect(parseBotCommand("/help")).toEqual({
      command: "help",
      mention: null,
      arg: null,
    });
  });

  it("keeps multi-word args intact and trims whitespace", () => {
    expect(parseBotCommand("  /watch two word name  ")).toEqual({
      command: "watch",
      mention: null,
      arg: "two word name",
    });
    expect(parseBotCommand("/og bonk inu")).toEqual({
      command: "og",
      mention: null,
      arg: "bonk inu",
    });
  });

  it("captures the @BotName mention", () => {
    expect(parseBotCommand(`/og@OGFindertekbot ${BONK}`)).toEqual({
      command: "og",
      mention: "OGFindertekbot",
      arg: BONK,
    });
    expect(parseBotCommand("/watches@OGFindertekbot")).toEqual({
      command: "watches",
      mention: "OGFindertekbot",
      arg: null,
    });
  });

  it("is case-insensitive on the command", () => {
    expect(parseBotCommand("/OG bonk")).toEqual({
      command: "og",
      mention: null,
      arg: "bonk",
    });
  });

  it("rejects non-commands, unknown commands, and legacy commands", () => {
    expect(parseBotCommand("gm")).toBeNull();
    expect(parseBotCommand("/ogx bonk")).toBeNull();
    expect(parseBotCommand("/og@")).toBeNull();
    expect(parseBotCommand("/start")).toBeNull(); // legacy parser's job
    expect(parseBotCommand("/stop")).toBeNull();
    expect(parseBotCommand("")).toBeNull();
  });
});

// ————————————————————————— VerdictCooldown —————————————————————————

describe("VerdictCooldown", () => {
  const TTL = 10 * 60_000;

  it("skips a repeat of the same chat+mint inside the TTL, allows after", () => {
    const cd = new VerdictCooldown(TTL, 100);
    const t0 = 1_000_000;
    expect(cd.check("c1", USDC, t0)).toBe(false);
    expect(cd.check("c1", USDC, t0 + TTL - 1)).toBe(true);
    expect(cd.check("c1", USDC, t0 + TTL)).toBe(false);
  });

  it("keys per chat AND per mint", () => {
    const cd = new VerdictCooldown(TTL, 100);
    const t0 = 1_000_000;
    expect(cd.check("c1", USDC, t0)).toBe(false);
    expect(cd.check("c2", USDC, t0)).toBe(false);
    expect(cd.check("c1", BONK, t0)).toBe(false);
    expect(cd.check("c1", USDC, t0 + 1)).toBe(true);
  });

  it("stays bounded: evicts oldest when full of fresh entries", () => {
    const cd = new VerdictCooldown(TTL, 3);
    cd.check("a", "m1", 0);
    cd.check("a", "m2", 1);
    cd.check("a", "m3", 2);
    cd.check("a", "m4", 3); // full of fresh entries → oldest (m1) evicted
    expect(cd.size).toBe(3);
    expect(cd.check("a", "m1", 4)).toBe(false); // m1 was evicted
  });

  it("sweeps expired entries before evicting fresh ones", () => {
    const cd = new VerdictCooldown(1_000, 2);
    cd.check("a", "m1", 0);
    cd.check("a", "m2", 0);
    cd.check("a", "m3", 5_000); // m1+m2 expired → swept, no fresh eviction
    expect(cd.size).toBe(1);
  });
});

// ————————————————————————— formatMintVerdict —————————————————————————

/** TokenResult fixture with required fields defaulted. */
function tok(over: Partial<TokenResult> & { mint: string }): TokenResult {
  return {
    displayName: "Token",
    displaySymbol: "TOK",
    slot: null,
    createdAtMs: null,
    createdAt: null,
    dexId: null,
    confidence: 1,
    confidenceLabel: "high",
    rank: 1,
    rankLabel: "#1",
    timeSource: "helius",
    ...over,
  };
}

const OG_CREATED = "2022-12-20T21:10:46.000Z";
const CLONE_CREATED = "2023-05-01T00:00:00.000Z";

describe("formatMintVerdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the full OG verdict: crown, age, risk, market, links", () => {
    const payload: MintScanPayload = {
      results: [
        tok({
          mint: BONK,
          displayName: "Bonk",
          displaySymbol: "BONK",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          metadataMutable: false,
          topHolderPct: 24.6,
          priceUsd: 0.0000345,
          marketCapUsd: 2_310_000_000,
          liquidityUsd: 4_520_000,
          priceChange24h: -3.21,
        }),
        tok({ mint: USDC, displayName: "Bonk2", rank: 2 }),
      ],
      query: "bonk",
      scanName: "Bonk",
      scanSymbol: "BONK",
    };
    const msg = formatMintVerdict(BONK, payload, SITE);
    expect(msg).toBe(
      [
        "👑 <b>THIS IS THE OG</b> — Bonk ($BONK)",
        `minted Dec 20, 2022 (${timeAgo(OG_CREATED)})`,
        "🔒 renounced · 👥 top10 hold 25%",
        "💰 MC $2.3B · liq $4.5M · -3.2% 24h",
        `<a href="${verdictShareUrl(BONK, payload, SITE)}">OGfinder verdict</a> · ` +
          `<a href="https://dexscreener.com/solana/${BONK}">DexScreener</a> · ` +
          `<a href="https://trade.padre.gg/trade/solana/${BONK}">Padre</a>`,
      ].join("\n")
    );
  });

  it("renders NOT-the-OG with rank, OG comparison line, and escaped HTML", () => {
    const gapMs = Date.parse(CLONE_CREATED) - Date.parse(OG_CREATED);
    const payload: MintScanPayload = {
      results: [
        tok({
          mint: BONK,
          displayName: "Bonk & Co",
          displaySymbol: "BONK",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
        }),
        tok({
          mint: USDC,
          displayName: "Bonk <2>",
          displaySymbol: "B&NK",
          rank: 2,
          createdAt: CLONE_CREATED,
          createdAtMs: Date.parse(CLONE_CREATED),
          mintAuthorityActive: true,
          freezeAuthorityActive: true,
          metadataMutable: true,
          homoglyphSuspect: true,
        }),
      ],
      query: "bonk",
      scanName: "Bonk <2>",
      scanSymbol: "B&NK",
    };
    const msg = formatMintVerdict(USDC, payload, SITE);
    expect(msg).toBe(
      [
        "🚫 <b>NOT THE OG</b> — Bonk &lt;2&gt; ($B&amp;NK) is #2 of 2 by age",
        `minted May 1, 2023 (${timeAgo(CLONE_CREATED)})`,
        `OG: <b>Bonk &amp; Co</b> minted Dec 20, 2022 (${formatAgeGap(gapMs)} older) — <code>${BONK}</code>`,
        "⚠️ mint auth active · ⚠️ freeze auth · ✏️ mutable metadata · 🎭 lookalike characters",
        `<a href="${verdictShareUrl(USDC, payload, SITE)}">OGfinder verdict</a> · ` +
          `<a href="https://dexscreener.com/solana/${USDC}">DexScreener</a> · ` +
          `<a href="https://trade.padre.gg/trade/solana/${USDC}">Padre</a>`,
      ].join("\n")
    );
  });

  it("omits risk/market lines when no flags or data exist, unknown date handled", () => {
    const payload: MintScanPayload = {
      results: [tok({ mint: WSOL, displayName: "Sol", displaySymbol: "SOL" })],
      query: "sol",
      scanName: "Sol",
      scanSymbol: "SOL",
    };
    const msg = formatMintVerdict(WSOL, payload, SITE);
    const lines = msg.split("\n");
    expect(lines).toHaveLength(3); // verdict, minted, links — nothing else
    expect(lines[1]).toBe("minted unknown date");
  });

  it("includes the dev line between risk and market when deployer data exists", () => {
    const payload: MintScanPayload = {
      results: [
        tok({
          mint: BONK,
          displayName: "Bonk",
          displaySymbol: "BONK",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
          mintAuthorityActive: false,
          priceUsd: 1.5,
          deployerAddress: "7cJMTHUnZBZU3R48cobe4FesyRuddaUyCBT7LoPATgLq",
          deployerTokensCreated: 3,
          deployerWalletFirstSeenMs: Date.parse("2024-01-15T00:00:00.000Z"),
        }),
      ],
      query: "bonk",
      scanName: "Bonk",
      scanSymbol: "BONK",
    };
    const lines = formatMintVerdict(BONK, payload, SITE).split("\n");
    expect(lines[2]).toBe("🔒 renounced");
    expect(lines[3]).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · 3 tokens created · wallet since 2024"
    );
    expect(lines[4]).toBe("💰 $1.50");
  });

  it("falls back to a resolve-only message when the mint is not in results", () => {
    const payload: MintScanPayload = {
      results: [tok({ mint: BONK, displayName: "Bonk", rank: 1 })],
      query: "bonk",
      scanName: "Ghost <T>",
      scanSymbol: "GH",
    };
    expect(formatMintVerdict(WSOL, payload, SITE)).toBe(
      "🔍 Resolved <b>Ghost &lt;T&gt;</b> ($GH) but couldn't rank it against lookalikes — try a name search on OGfinder."
    );
  });
});

// ————————————— formatMintVerdict: unproven age ordering —————————————

describe("formatMintVerdict order gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Rank 1 is exactly dated, but #2's walk was truncated — it could be older. */
  const unprovenPayload = (): MintScanPayload => ({
    results: [
      tok({
        mint: BONK,
        displayName: "Bonk",
        displaySymbol: "BONK",
        rank: 1,
        createdAt: OG_CREATED,
        createdAtMs: Date.parse(OG_CREATED),
        ageOrderUnproven: true,
      }),
      tok({
        mint: USDC,
        displayName: "Bonk",
        displaySymbol: "BONK",
        rank: 2,
        createdAt: CLONE_CREATED,
        createdAtMs: Date.parse(CLONE_CREATED),
        createdAtIsLowerBound: true,
      }),
    ],
    query: "bonk",
    scanName: "Bonk",
    scanSymbol: "BONK",
    ageOrderUnproven: true,
    ageUnresolvedCount: 1,
  });

  it("never crowns a rank-1 whose ordering is unproven", () => {
    const lines = formatMintVerdict(BONK, unprovenPayload(), SITE).split("\n");
    expect(lines[0]).toBe("🕰 <b>OLDEST KNOWN</b> — Bonk ($BONK), but not proven");
    expect(lines[0]).not.toContain("THIS IS THE OG");
    expect(lines[0]).not.toContain("👑");
    // The limit is stated, with the count, right under the age claim.
    expect(lines[2]).toContain("1 matching token has a history too deep");
    expect(lines[2]).toContain("not a verified OG");
  });

  it("hedges the comparison line for a NOT-the-OG scan too", () => {
    const lines = formatMintVerdict(USDC, unprovenPayload(), SITE).split("\n");
    expect(lines[0]).toContain("NOT THE OG");
    expect(lines[2]).toBe(
      `Oldest known: <b>Bonk</b> minted Dec 20, 2022 (${formatAgeGap(
        Date.parse(CLONE_CREATED) - Date.parse(OG_CREATED)
      )} older) — <code>${BONK}</code>`
    );
  });

  it("marks the share link so the unfurled card drops the gold OG band", () => {
    const payload = unprovenPayload();
    expect(verdictShareUrl(BONK, payload, SITE)).toContain("&u=1");
    // A proven cohort's link is untouched.
    const proven: MintScanPayload = {
      ...payload,
      results: [
        tok({
          mint: BONK,
          displayName: "Bonk",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
        }),
      ],
      ageOrderUnproven: undefined,
      ageUnresolvedCount: undefined,
    };
    expect(verdictShareUrl(BONK, proven, SITE)).not.toContain("&u=");
  });
});

// ————————————————— formatMintVerdict: safety gating —————————————————

/** Single-token scan payload for safety-level fixtures. */
function scanOf(t: TokenResult): MintScanPayload {
  return {
    results: [t],
    query: "bonk",
    scanName: t.displayName,
    scanSymbol: t.displaySymbol,
  };
}

describe("formatMintVerdict safety gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const dangerToken = (over?: Partial<TokenResult>) =>
    tok({
      mint: BONK,
      displayName: "Bonk",
      displaySymbol: "BONK",
      rank: 1,
      createdAt: OG_CREATED,
      createdAtMs: Date.parse(OG_CREATED),
      safetyLevel: "danger",
      safetyFlags: ["freeze-authority", "mint-authority", "mutable-metadata"],
      ...over,
    });

  it("leads with the warning and NEVER crowns a danger token", () => {
    const payload = scanOf(dangerToken());
    const msg = formatMintVerdict(BONK, payload, SITE);
    const lines = msg.split("\n");
    expect(lines[0]).toBe("🛑 <b>UNSAFE — DO NOT BUY</b> — Bonk ($BONK)");
    // Each blocking mechanism named — never a generic accusation.
    expect(lines[1]).toBe("⛔ freeze authority active");
    expect(lines[2]).toBe(
      "oldest by age, but OGfinder will not call it the OG"
    );
    // The age fact itself survives untouched.
    expect(lines[3]).toBe(`minted Dec 20, 2022 (${timeAgo(OG_CREATED)})`);
    // Cautions still reported, in the risk slot, below the blocking findings.
    expect(lines[4]).toBe("⚠️ mint authority active · metadata still mutable");
    // Grep our own output: no crown, no endorsement, no accusation.
    expect(msg).not.toContain("👑");
    expect(msg).not.toContain("THIS IS THE OG");
    expect(msg).not.toContain("OG</b> — Bonk");
    expect(msg.toLowerCase()).not.toContain("scam");
    // Links line still last.
    expect(lines[lines.length - 1]).toContain("DexScreener");
  });

  it("keeps the factual rank line for a danger token that is NOT the oldest", () => {
    const payload: MintScanPayload = {
      results: [
        tok({ mint: WSOL, displayName: "Bonk", rank: 1 }),
        dangerToken({
          mint: USDC,
          rank: 2,
          // Server severity order within a tier is preserved as emitted.
          safetyFlags: ["transfer-hook", "no-sells"],
        }),
      ],
      query: "bonk",
      scanName: "Bonk",
      scanSymbol: "BONK",
    };
    const lines = formatMintVerdict(USDC, payload, SITE).split("\n");
    expect(lines[0]).toBe("🛑 <b>UNSAFE — DO NOT BUY</b> — Bonk ($BONK)");
    expect(lines[1]).toBe("⛔ transfer hook program · buys but no sells");
    expect(lines[2]).toBe("🚫 <b>NOT THE OG</b> — #2 of 2 by age");
  });

  it("keeps the crown for a caution token and appends the findings", () => {
    const payload = scanOf(
      dangerToken({
        safetyLevel: "caution",
        safetyFlags: ["mutable-metadata"],
      })
    );
    const lines = formatMintVerdict(BONK, payload, SITE).split("\n");
    expect(lines[0]).toBe("👑 <b>THIS IS THE OG</b> — Bonk ($BONK)");
    expect(lines[2]).toBe("⚠️ metadata still mutable");
  });

  it("reports 'clear' as an absence of findings, never as safe", () => {
    const payload = scanOf(
      dangerToken({ safetyLevel: "clear", safetyFlags: [] })
    );
    const msg = formatMintVerdict(BONK, payload, SITE);
    expect(msg.split("\n")[2]).toBe("🔎 no blocking flags found");
    expect(msg.toLowerCase()).not.toContain("safe");
  });

  it("reports 'unknown' as checks unavailable, never as a clean result", () => {
    const payload = scanOf(
      dangerToken({ safetyLevel: "unknown", safetyFlags: [] })
    );
    const msg = formatMintVerdict(BONK, payload, SITE);
    expect(msg.split("\n")[2]).toBe("❔ safety checks unavailable");
    expect(msg).not.toContain("no blocking flags found");
    // An unrun check must not cost the rank-1 token its crown.
    expect(msg).toContain("👑 <b>THIS IS THE OG</b>");
  });

  it("prints the 24h buy/sell counts behind a no-sells finding", () => {
    const payload = scanOf(
      dangerToken({
        safetyFlags: ["no-sells"],
        buys24h: 212,
        sells24h: 0,
        liquidityUsd: 18_400,
      })
    );
    const msg = formatMintVerdict(BONK, payload, SITE);
    expect(msg).toContain("💰 liq $18.4K · 212 buys / 0 sells 24h");
  });

  it("leaves an UNASSESSED token on the legacy chips (absent is not clean)", () => {
    const payload = scanOf(
      tok({
        mint: BONK,
        displayName: "Bonk",
        displaySymbol: "BONK",
        rank: 1,
        freezeAuthorityActive: true,
      })
    );
    const msg = formatMintVerdict(BONK, payload, SITE);
    expect(msg).toContain("⚠️ freeze auth");
    expect(msg).not.toContain("no blocking flags found");
    expect(msg).not.toContain("safety checks unavailable");
  });
});

describe("formatBlockingFlagLine / formatSafetyRiskChip", () => {
  it("orders blocking findings first and drops unknown codes", () => {
    const t = tok({
      mint: BONK,
      safetyFlags: [
        "mint-authority",
        "bogus-code" as never,
        "permanent-delegate",
      ],
    });
    expect(formatBlockingFlagLine(t)).toBe("⛔ permanent delegate set");
    expect(formatSafetyRiskChip({ ...t, safetyLevel: "danger" })).toBe(
      "⚠️ mint authority active"
    );
  });

  it("returns null when nothing blocks and when the token was never assessed", () => {
    expect(formatBlockingFlagLine(tok({ mint: BONK }))).toBeNull();
    expect(
      formatBlockingFlagLine(tok({ mint: BONK, safetyFlags: ["low-liquidity"] }))
    ).toBeNull();
    expect(formatSafetyRiskChip(tok({ mint: BONK }))).toBeNull();
  });
});

describe("verdictShareUrl safety marker", () => {
  it("appends ?sf=<headline blocking code> for a danger verdict only", () => {
    const danger = scanOf(
      tok({
        mint: BONK,
        rank: 1,
        safetyLevel: "danger",
        safetyFlags: ["mint-authority", "freeze-authority"],
      })
    );
    const url = new URL(verdictShareUrl(BONK, danger, SITE));
    // Blocking-first ordering picks the mechanism, not the first code listed.
    expect(url.searchParams.get("sf")).toBe("freeze-authority");
    // The frozen ?v= contract is untouched by the marker.
    expect(decodeSharePayload(url.searchParams.get("v")!)?.m).toBe(BONK);

    const caution = scanOf(
      tok({
        mint: BONK,
        rank: 1,
        safetyLevel: "caution",
        safetyFlags: ["mint-authority"],
      })
    );
    expect(
      new URL(verdictShareUrl(BONK, caution, SITE)).searchParams.get("sf")
    ).toBeNull();
  });
});

// ————————————————————————— formatDeployerLine —————————————————————————

describe("formatDeployerLine", () => {
  const DEV = "7cJMTHUnZBZU3R48cobe4FesyRuddaUyCBT7LoPATgLq";
  const NOW = Date.parse("2026-08-02T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("returns null without a deployer address", () => {
    expect(formatDeployerLine(tok({ mint: BONK }), NOW)).toBeNull();
    expect(
      formatDeployerLine(
        tok({ mint: BONK, deployerTokensCreated: 50 }), // count but no address
        NOW
      )
    ).toBeNull();
  });

  it("renders address-only when profile fields are null (graceful omission)", () => {
    const line = formatDeployerLine(
      tok({
        mint: BONK,
        deployerAddress: DEV,
        deployerTokensCreated: null,
        deployerWalletFirstSeenMs: null,
      }),
      NOW
    );
    expect(line).toBe("👤 dev: <code>7cJM…TgLq</code>");
  });

  it("flags serial deployers at the ≥10 threshold, plain count below", () => {
    const at = (n: number) =>
      formatDeployerLine(
        tok({ mint: BONK, deployerAddress: DEV, deployerTokensCreated: n }),
        NOW
      );
    expect(at(9)).toBe("👤 dev: <code>7cJM…TgLq</code> · 9 tokens created");
    expect(at(10)).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · ⚠️ serial deployer: 10 tokens created"
    );
    expect(at(1)).toBe("👤 dev: <code>7cJM…TgLq</code> · 1 token created");
    // The Enhanced-API count is one page — the cap reads as "or more".
    expect(at(100)).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · ⚠️ serial deployer: 100+ tokens created"
    );
  });

  it("flags fresh wallets (<7d) and shows the year for older ones", () => {
    const at = (ms: number) =>
      formatDeployerLine(
        tok({ mint: BONK, deployerAddress: DEV, deployerWalletFirstSeenMs: ms }),
        NOW
      );
    expect(at(NOW - 6 * DAY)).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · ⚠️ fresh wallet"
    );
    // Boundary: exactly 7 days is no longer fresh.
    expect(at(NOW - 7 * DAY)).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · wallet since 2026"
    );
    expect(at(Date.parse("2022-03-01T00:00:00.000Z"))).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · wallet since 2022"
    );
  });

  it("renders 'established wallet' when history is too deep to date", () => {
    const line = formatDeployerLine(
      tok({
        mint: BONK,
        deployerAddress: DEV,
        deployerTokensCreated: 12,
        deployerWalletFirstSeenMs: null,
        deployerIsOldWallet: true,
      }),
      NOW
    );
    expect(line).toBe(
      "👤 dev: <code>7cJM…TgLq</code> · ⚠️ serial deployer: 12 tokens created · established wallet"
    );
  });
});

describe("verdictShareUrl", () => {
  it("builds a /?q=&v= URL whose payload decodes to the ScanHero shape", () => {
    const payload: MintScanPayload = {
      results: [
        tok({
          mint: BONK,
          displayName: "Bonk",
          displaySymbol: "BONK",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
        }),
        tok({ mint: USDC, displayName: "Bonk2", rank: 2 }),
      ],
      query: "bonk",
      scanName: "Bonk",
      scanSymbol: "BONK",
    };
    const url = new URL(verdictShareUrl(BONK, payload, SITE));
    expect(url.origin).toBe(SITE);
    expect(url.searchParams.get("q")).toBe(BONK);
    expect(decodeSharePayload(url.searchParams.get("v")!)).toEqual({
      n: "Bonk",
      s: "BONK",
      d: OG_CREATED,
      r: 1,
      t: 2,
      o: true,
      m: BONK,
    });
  });
});

// ————————————————————————— formatRegistryVerdict —————————————————————————

describe("formatRegistryVerdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function entry(over?: Partial<OgRegistryEntry>): OgRegistryEntry {
    return {
      ogMint: BONK,
      ogName: "Bonk",
      ogSymbol: "BONK",
      ogCreatedAtMs: Date.parse(OG_CREATED),
      verifiedAt: Date.now(),
      scanCount: 3,
      ...over,
    };
  }

  it("states the age fact WITHOUT crowning while safety checks are pending", () => {
    const msg = formatRegistryVerdict(BONK, entry());
    expect(msg).toBe(
      [
        "⏳ <b>OLDEST BY AGE</b> — Bonk ($BONK) is the oldest token of this name (checked today)",
        "(from OGfinder registry — safety checks still running, full verdict next)",
      ].join("\n")
    );
    // The endorsement belongs to the full scan, which has the safety verdict.
    expect(msg).not.toContain("👑");
    expect(msg).not.toContain("THIS IS THE OG");
  });

  it("flags a non-OG with the registered OG's mint and mint date", () => {
    expect(formatRegistryVerdict(USDC, entry())).toBe(
      [
        `🚫 <b>NOT THE OG</b> — the OG of "Bonk" ($BONK) is <code>${BONK}</code>, minted Dec 20, 2022`,
        "(from OGfinder registry — full re-check running)",
      ].join("\n")
    );
  });

  it("omits the mint date when unknown and escapes HTML in name/symbol", () => {
    const msg = formatRegistryVerdict(
      USDC,
      entry({ ogName: "Bonk <&> Co", ogSymbol: "B&NK", ogCreatedAtMs: null })
    );
    expect(msg).toContain('the OG of "Bonk &lt;&amp;&gt; Co" ($B&amp;NK)');
    expect(msg).not.toContain("minted");
    expect(msg).toContain(`<code>${BONK}</code>`);
  });

  it("omits the symbol suffix when null", () => {
    const msg = formatRegistryVerdict(BONK, entry({ ogSymbol: null }));
    expect(msg).toContain("— Bonk is the oldest token of this name");
  });
});

// ————————————————————————— formatNameSearchReply —————————————————————————

describe("formatNameSearchReply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders top pick, two runners-up, count, and the search link", () => {
    const results = [
      tok({
        mint: BONK,
        displayName: "Bonk",
        displaySymbol: "BONK",
        rank: 1,
        createdAt: OG_CREATED,
        createdAtMs: Date.parse(OG_CREATED),
      }),
      tok({
        mint: USDC,
        displayName: "Bonk 2.0",
        displaySymbol: "BONK2",
        rank: 2,
        createdAt: CLONE_CREATED,
        createdAtMs: Date.parse(CLONE_CREATED),
      }),
      tok({ mint: WSOL, displayName: "Bonk Inu", displaySymbol: "BINU", rank: 3 }),
      tok({ mint: "Mint4", displayName: "Bonk 4", rank: 4 }),
    ];
    expect(formatNameSearchReply("bonk", results, SITE)).toBe(
      [
        `👑 Likely OG: <b>Bonk</b> ($BONK) — minted Dec 20, 2022 (${timeAgo(OG_CREATED)})`,
        `<code>${BONK}</code>`,
        `#2 Bonk 2.0 ($BONK2) — minted May 1, 2023 (${timeAgo(CLONE_CREATED)})`,
        "#3 Bonk Inu ($BINU) — age unknown",
        `4 tokens ranked by best-known age — <a href="${SITE}/?q=bonk">open the link for on-chain verification</a>`,
      ].join("\n")
    );
  });

  it("handles a single result and no results", () => {
    const one = [
      tok({ mint: WSOL, displayName: "Sol", displaySymbol: "SOL", rank: 1 }),
    ];
    const single = formatNameSearchReply("sol", one, SITE);
    expect(single.split("\n")).toHaveLength(3); // top, mint, label — no runners
    expect(single).toContain("1 token ranked by best-known age");
    expect(formatNameSearchReply("nope coin", [], SITE)).toBe(
      `No tokens found named "nope coin" — <a href="${SITE}/?q=nope%20coin">search on OGfinder</a>`
    );
  });

  it("withholds the crown when the oldest match carries a blocking flag", () => {
    const results = [
      tok({
        mint: BONK,
        displayName: "Bonk",
        displaySymbol: "BONK",
        rank: 1,
        createdAt: OG_CREATED,
        createdAtMs: Date.parse(OG_CREATED),
        safetyLevel: "danger",
        safetyFlags: ["default-frozen"],
      }),
      tok({ mint: USDC, displayName: "Bonk 2.0", rank: 2 }),
    ];
    const msg = formatNameSearchReply("bonk", results, SITE);
    const lines = msg.split("\n");
    expect(lines[0]).toBe(
      `🛑 <b>UNSAFE — DO NOT BUY</b> — <b>Bonk</b> ($BONK) — minted Dec 20, 2022 (${timeAgo(OG_CREATED)})`
    );
    expect(lines[1]).toBe("⛔ new accounts start frozen");
    expect(lines[2]).toBe("oldest by age, but OGfinder will not call it the OG");
    expect(lines[3]).toBe(`<code>${BONK}</code>`);
    expect(msg).not.toContain("👑");
    // Ranking below it is unchanged — the list is still factual.
    expect(msg).toContain("#2 Bonk 2.0");
  });

  it("escapes HTML in the query and token fields", () => {
    const msg = formatNameSearchReply(
      "a<b>",
      [tok({ mint: WSOL, displayName: "<X> & Co", displaySymbol: "A&B", rank: 1 })],
      SITE
    );
    expect(msg).toContain("<b>&lt;X&gt; &amp; Co</b> ($A&amp;B)");
    expect(msg).toContain(`${SITE}/?q=a%3Cb%3E`);
  });
});

// ————————————————————————— update router (fixtures) —————————————————————————

/**
 * Fresh in-memory DB per test — the modules hold a connection singleton.
 * TELEGRAM_BOT_TOKEN is cleared so every Bot API call no-ops (tgCall returns
 * null): the router's DB effects are observable, sends are not attempted.
 */
async function freshTelegram() {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  delete process.env.TELEGRAM_BOT_TOKEN;
  const telegram = await import("@/lib/telegram");
  const urlIndex = await import("@/lib/url-index");
  const watches = await import("@/lib/watches");
  return { ...telegram, ...urlIndex, ...watches };
}

beforeEach(() => {
  process.env.OGFINDER_DB_PATH = ":memory:";
});

type GroupRow = { chat_id: string; title: string | null; welcome_sent: number; active: number };

function groupRow(lib: Awaited<ReturnType<typeof freshTelegram>>, chatId: string) {
  return lib
    .getDb()
    .prepare(
      "SELECT chat_id, title, welcome_sent, active FROM telegram_groups WHERE chat_id = ?"
    )
    .get(chatId) as GroupRow | undefined;
}

describe("handleTelegramUpdate (fixture updates)", () => {
  it("registers a group and marks the welcome on my_chat_member=member", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate({
      update_id: 1,
      my_chat_member: {
        chat: { id: -100123, type: "supergroup", title: "Bonk Army" },
        new_chat_member: { status: "member" },
      },
    });
    expect(groupRow(lib, "-100123")).toEqual({
      chat_id: "-100123",
      title: "Bonk Army",
      welcome_sent: 1, // welcome attempted (no token → send no-ops) then marked
      active: 1,
    });
  });

  it("deactivates on kicked and reactivates without re-welcoming", async () => {
    const lib = await freshTelegram();
    const member = (status: string) => ({
      update_id: 1,
      my_chat_member: {
        chat: { id: -5, type: "group" as const, title: "g" },
        new_chat_member: { status },
      },
    });
    await lib.handleTelegramUpdate(member("member"));
    await lib.handleTelegramUpdate(member("kicked"));
    expect(groupRow(lib, "-5")?.active).toBe(0);
    await lib.handleTelegramUpdate(member("administrator"));
    const row = groupRow(lib, "-5");
    expect(row?.active).toBe(1);
    expect(row?.welcome_sent).toBe(1); // never reset — no duplicate welcome
  });

  it("ignores private-chat membership updates and channel chats", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate({
      update_id: 1,
      my_chat_member: {
        chat: { id: 777, type: "private" },
        new_chat_member: { status: "member" },
      },
    });
    await lib.handleTelegramUpdate({
      update_id: 2,
      my_chat_member: {
        chat: { id: -42, type: "channel" },
        new_chat_member: { status: "member" },
      },
    });
    expect(groupRow(lib, "777")).toBeUndefined();
    expect(groupRow(lib, "-42")).toBeUndefined();
  });

  it("routes messages safely: bot senders, unregistered groups, empty updates", async () => {
    const lib = await freshTelegram();
    // None of these should throw or touch the registry.
    await lib.handleTelegramUpdate({ update_id: 1 });
    await lib.handleTelegramUpdate({
      update_id: 2,
      message: {
        message_id: 10,
        from: { is_bot: true },
        chat: { id: -100123, type: "supergroup" },
        text: USDC,
      },
    });
    await lib.handleTelegramUpdate({
      update_id: 3,
      message: {
        message_id: 11,
        chat: { id: -999, type: "supergroup" }, // never registered
        text: USDC,
      },
    });
    // Private chat with a mint: placeholder send no-ops without a token, so
    // no scan is started — the router just resolves.
    await lib.handleTelegramUpdate({
      update_id: 4,
      message: {
        message_id: 12,
        chat: { id: 555, type: "private" },
        text: `look at ${USDC}`,
      },
    });
    expect(groupRow(lib, "-999")).toBeUndefined();
  });
});

// ————————————————————— /watch, /unwatch, mention gating —————————————————————

type Lib = Awaited<ReturnType<typeof freshTelegram>>;

function groupMsg(chatId: number, text: string, messageId = 1) {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: "supergroup" as const, title: "Bonk Army" },
      text,
    },
  };
}

function watchRows(lib: Lib) {
  return lib
    .getDb()
    .prepare(
      "SELECT id, display_query, created_by_ip, telegram_chat_id FROM watched_queries ORDER BY id"
    )
    .all() as {
    id: number;
    display_query: string;
    created_by_ip: string;
    telegram_chat_id: string | null;
  }[];
}

describe("telegramWatchIpKey", () => {
  it("keys the per-IP cap per chat", () => {
    expect(telegramWatchIpKey("-100123")).toBe("tg:-100123");
    expect(telegramWatchIpKey("555")).toBe("tg:555");
  });
});

describe("/watch and /unwatch via the update router", () => {
  it("/watch creates a chat-keyed watch, links delivery, self-registers the group", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate(groupMsg(-100123, "/watch bonk inu"));
    expect(watchRows(lib)).toEqual([
      {
        id: 1,
        display_query: "bonk inu",
        created_by_ip: "tg:-100123",
        telegram_chat_id: "-100123",
      },
    ]);
    // Command from an unregistered group registers it without a welcome.
    expect(groupRow(lib, "-100123")).toEqual({
      chat_id: "-100123",
      title: "Bonk Army",
      welcome_sent: 1,
      active: 1,
    });
  });

  it("caps at 10 watches per chat, independently across chats", async () => {
    const lib = await freshTelegram();
    for (let i = 0; i < 10; i++) {
      const res = lib.createWatch({
        query: `clone name ${i}`,
        ip: lib.telegramWatchIpKey("-1"),
        telegramChatId: "-1",
      });
      expect(res.ok).toBe(true);
    }
    await lib.handleTelegramUpdate(groupMsg(-1, "/watch eleventh name"));
    expect(watchRows(lib).filter((w) => w.created_by_ip === "tg:-1")).toHaveLength(10);
    // A different chat has its own cap of 10.
    await lib.handleTelegramUpdate(groupMsg(-2, "/watch eleventh name"));
    const other = watchRows(lib).filter((w) => w.created_by_ip === "tg:-2");
    expect(other).toHaveLength(1);
    expect(other[0].telegram_chat_id).toBe("-2");
  });

  it("repeat /watch of the same name is idempotent and re-links the chat", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate(groupMsg(-9, "/watch bonk"));
    // Simulate /stop-style unlink, then re-watch.
    lib
      .getDb()
      .prepare("UPDATE watched_queries SET telegram_chat_id = NULL")
      .run();
    await lib.handleTelegramUpdate(groupMsg(-9, "/watch bonk"));
    const rows = watchRows(lib);
    expect(rows).toHaveLength(1);
    expect(rows[0].telegram_chat_id).toBe("-9");
  });

  it("/unwatch by id only removes watches owned by the asking chat", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate(groupMsg(-1, "/watch bonk"));
    const id = watchRows(lib)[0].id;
    await lib.handleTelegramUpdate(groupMsg(-2, `/unwatch ${id}`));
    expect(watchRows(lib)).toHaveLength(1); // foreign chat can't remove it
    await lib.handleTelegramUpdate(groupMsg(-1, `/unwatch ${id}`));
    expect(watchRows(lib)).toHaveLength(0);
  });

  it("/unwatch by name matches via skeleton", async () => {
    const lib = await freshTelegram();
    await lib.handleTelegramUpdate(groupMsg(-1, "/watch Bonk Inu"));
    await lib.handleTelegramUpdate(groupMsg(-1, "/unwatch bonk inu"));
    expect(watchRows(lib)).toHaveLength(0);
  });

  it("ignores commands addressed to another bot when the username is known", async () => {
    const lib = await freshTelegram();
    process.env.TELEGRAM_BOT_USERNAME = "OGFindertekbot";
    try {
      await lib.handleTelegramUpdate(
        groupMsg(-7, "/watch@SomeOtherBot bonk")
      );
      expect(watchRows(lib)).toHaveLength(0);
      // Mention matching is case-insensitive.
      await lib.handleTelegramUpdate(
        groupMsg(-7, "/watch@ogfindertekbot bonk")
      );
      expect(watchRows(lib)).toHaveLength(1);
    } finally {
      delete process.env.TELEGRAM_BOT_USERNAME;
    }
  });
});
