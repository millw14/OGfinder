import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractMintCandidates,
  formatBlockingRows,
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
import { CONCENTRATION_PCT } from "@/lib/safety";

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

/** Header sub-line age: the same value timeAgo gives, minus the " ago". */
const age = (iso: string) => timeAgo(iso).replace(/ ago$/, "");

describe("formatMintVerdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the full OG verdict as a header + Stats + Security tree", () => {
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
    const msg = formatMintVerdict(BONK, payload);
    // Sections separated by a blank line; inside one, every row but the last
    // is "├ " and the last is "└ ".
    expect(msg).toBe(
      [
        `👑 <b>Bonk</b> ($BONK)\n└ <b>THE OG</b> · ${age(OG_CREATED)} · #1 of 2`,
        [
          "📊 <b>Stats</b>",
          "├ <code>Born  </code> Dec 20, 2022",
          "├ <code>MC    </code> $2.3B",
          "├ <code>Liq   </code> $4.5M",
          "└ <code>24H   </code> -3.2%",
        ].join("\n"),
        [
          "🔒 <b>Security</b>",
          "├ <code>Auth  </code> 🟢 renounced",
          "└ <code>Top 10</code> 25%",
        ].join("\n"),
      ].join("\n\n")
    );
    // The links left the text for the inline keyboard — no anchors survive.
    expect(msg).not.toContain("<a href");
  });

  it("renders NOT-the-OG with rank, the OG's own section, and escaped HTML", () => {
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
    const msg = formatMintVerdict(USDC, payload);
    // Four sections: verdict header · the real OG · Stats · Security.
    expect(msg).toBe(
      [
        "🚫 <b>Bonk &lt;2&gt;</b> ($B&amp;NK)\n" +
          `└ <b>NOT THE OG</b> · #2 of 2 · ${age(CLONE_CREATED)}`,
        [
          "👑 <b>The OG</b>",
          "├ Bonk &amp; Co ($BONK)",
          `├ <code>Born  </code> Dec 20, 2022 · ${formatAgeGap(gapMs)} older`,
          `└ <code>${BONK}</code>`,
        ].join("\n"),
        "📊 <b>Stats</b>\n└ <code>Born  </code> May 1, 2023",
        [
          "🔒 <b>Security</b>",
          "├ <code>Auth  </code> ⚠️ mint + freeze active",
          "├ <code>Meta  </code> ⚠️ mutable",
          "└ <code>Name  </code> 🎭 lookalike chars",
        ].join("\n"),
      ].join("\n\n")
    );
    // The pasted CA is never echoed back — only the OG's mint gets a <code>.
    expect(msg).not.toContain(`<code>${USDC}</code>`);
  });

  it("drops every empty row AND every empty section when no data exists", () => {
    const payload: MintScanPayload = {
      results: [tok({ mint: WSOL, displayName: "Sol", displaySymbol: "SOL" })],
      query: "sol",
      scanName: "Sol",
      scanSymbol: "SOL",
    };
    const msg = formatMintVerdict(WSOL, payload);
    // Nothing is known but the rank, so the header is the whole message —
    // no empty Stats/Security heads, no unknown-date placeholder row.
    expect(msg).toBe("👑 <b>Sol</b> ($SOL)\n└ <b>THE OG</b> · #1 of 1");
    expect(msg.split("\n\n")).toHaveLength(1);
    expect(msg).not.toContain("Stats");
    expect(msg).not.toContain("Security");
  });

  it("puts the deployer in the Security tree when deployer data exists", () => {
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
    const blocks = formatMintVerdict(BONK, payload).split("\n\n");
    // Stats: born then the market rows; price stands in for a missing MC.
    expect(blocks[1]).toBe(
      "📊 <b>Stats</b>\n├ <code>Born  </code> Dec 20, 2022\n└ <code>Price </code> $1.50"
    );
    // Security: fixed row order — authority, then the dev row, last.
    expect(blocks[2]).toBe(
      [
        "🔒 <b>Security</b>",
        // freeze authority was never reported, so only the mint side is claimed
        "├ <code>Auth  </code> 🟢 mint renounced",
        "└ <code>Dev   </code> <code>7cJM…TgLq</code> · 3 launches · 2024",
      ].join("\n")
    );
  });

  it("falls back to a resolve-only message when the mint is not in results", () => {
    const payload: MintScanPayload = {
      results: [tok({ mint: BONK, displayName: "Bonk", rank: 1 })],
      query: "bonk",
      scanName: "Ghost <T>",
      scanSymbol: "GH",
    };
    expect(formatMintVerdict(WSOL, payload)).toBe(
      "🔍 <b>Ghost &lt;T&gt;</b> ($GH)\n└ couldn't rank vs lookalikes"
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

  it("never crowns a rank-1 whose ordering is unproven, and counts what blocks it", () => {
    const blocks = formatMintVerdict(BONK, unprovenPayload()).split("\n\n");
    expect(blocks[0]).toBe(
      `🕰 <b>Bonk</b> ($BONK)\n└ <b>OLDEST KNOWN</b> · ${age(OG_CREATED)} · #1 of 2`
    );
    expect(blocks[0]).not.toMatch(/\bTHE OG\b/);
    expect(blocks[0]).not.toContain("👑");
    // The limit is stated, with the count, as the Security tree's Age row —
    // a row that can never be dropped, since it forces the section to exist.
    expect(blocks.at(-1)).toBe(
      "🔒 <b>Security</b>\n└ <code>Age   </code> ⏳ 1 unverified"
    );
  });

  it("says the order is unproven when the count is unavailable", () => {
    const payload = { ...unprovenPayload(), ageUnresolvedCount: undefined };
    const blocks = formatMintVerdict(BONK, payload).split("\n\n");
    expect(blocks[0]).toContain("<b>OLDEST KNOWN</b>");
    expect(blocks[0]).not.toContain("👑");
    expect(blocks.at(-1)).toBe(
      "🔒 <b>Security</b>\n└ <code>Age   </code> ⏳ order unproven"
    );
  });

  it("hedges the OG section for a NOT-the-OG scan too", () => {
    const msg = formatMintVerdict(USDC, unprovenPayload());
    const blocks = msg.split("\n\n");
    expect(blocks[0]).toContain("NOT THE OG");
    // Nothing in an unproven message is crowned — not even the cohort's #1.
    expect(msg).not.toContain("👑");
    // The scanned side is the truncated one, so its own date is a bound ("≤")
    // and its age a minimum ("≥"); the gap to #1 is an upper limit.
    expect(blocks[0]).toBe(
      "🚫 <b>Bonk</b> ($BONK)\n" +
        `└ <b>NOT THE OG</b> · #2 of 2 · ≥ ${age(CLONE_CREATED)}`
    );
    expect(blocks[1]).toBe(
      [
        "🕰 <b>Oldest known</b>",
        "├ Bonk ($BONK)",
        `├ <code>Born  </code> Dec 20, 2022 · ≤ ${formatAgeGap(
          Date.parse(CLONE_CREATED) - Date.parse(OG_CREATED)
        )} older`,
        `└ <code>${BONK}</code>`,
      ].join("\n")
    );
    expect(blocks[2]).toBe("📊 <b>Stats</b>\n└ <code>Born  </code> ≤ May 1, 2023");
  });

  it("bounds the gap the other way when the #1 is the truncated side", () => {
    const p = unprovenPayload();
    p.results[0].createdAtIsLowerBound = true;
    delete p.results[1].createdAtIsLowerBound;
    const blocks = formatMintVerdict(USDC, p).split("\n\n");
    expect(blocks[0]).toBe(
      `🚫 <b>Bonk</b> ($BONK)\n└ <b>NOT THE OG</b> · #2 of 2 · ${age(CLONE_CREATED)}`
    );
    expect(blocks[1]).toBe(
      [
        "🕰 <b>Oldest known</b>",
        "├ Bonk ($BONK)",
        `├ <code>Born  </code> ≤ Dec 20, 2022 · ≥ ${formatAgeGap(
          Date.parse(CLONE_CREATED) - Date.parse(OG_CREATED)
        )} older`,
        `└ <code>${BONK}</code>`,
      ].join("\n")
    );
  });

  it("drops the gap entirely when BOTH dates are bounds", () => {
    const p = unprovenPayload();
    p.results[0].createdAtIsLowerBound = true;
    const blocks = formatMintVerdict(USDC, p).split("\n\n");
    expect(blocks[1]).toBe(
      [
        "🕰 <b>Oldest known</b>",
        "├ Bonk ($BONK)",
        "├ <code>Born  </code> ≤ Dec 20, 2022",
        `└ <code>${BONK}</code>`,
      ].join("\n")
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
    const msg = formatMintVerdict(BONK, payload);
    const blocks = msg.split("\n\n");
    // The warning IS the verdict sub-line; the rank fact survives beside it.
    expect(blocks[0]).toBe(
      "🛑 <b>Bonk</b> ($BONK)\n└ <b>UNSAFE — DO NOT BUY</b> · #1 of 1 · " +
        `${age(OG_CREATED)} · uncrowned`
    );
    // Each blocking mechanism named, one row each — never a generic accusation.
    expect(blocks[1]).toBe("⛔ <b>Blocking</b>\n└ freeze authority active");
    // The age fact itself survives untouched, in Stats.
    expect(blocks[2]).toBe("📊 <b>Stats</b>\n└ <code>Born  </code> Dec 20, 2022");
    // Cautions still reported, in the Security tree, below the blocking ones.
    expect(blocks[3]).toBe(
      "🔒 <b>Security</b>\n└ <code>Risk  </code> ⚠️ mint authority active · metadata still mutable"
    );
    // Grep our own output: no crown, no endorsement, no accusation.
    expect(msg).not.toContain("👑");
    expect(msg).not.toMatch(/\bTHE OG\b/);
    expect(msg.toLowerCase()).not.toContain("scam");
  });

  it("keeps the factual rank for a danger token that is NOT the oldest", () => {
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
    const msg = formatMintVerdict(USDC, payload);
    const blocks = msg.split("\n\n");
    // The rank fact rides in the verdict sub-line, stated but never turned
    // into a headline that competes with the warning.
    expect(blocks[0]).toBe(
      `🛑 <b>Bonk</b> ($BONK)\n└ <b>UNSAFE — DO NOT BUY</b> · #2 of 2 · ${age(OG_CREATED)}`
    );
    // The scanned token is never the crowned one — no crown in its header.
    expect(blocks[0]).not.toContain("👑");
    expect(blocks[1]).toBe(
      "⛔ <b>Blocking</b>\n├ transfer hook program\n└ buys but no sells"
    );
    // …the crown belongs to the cohort's actual #1, in its own section.
    expect(blocks[2]).toBe(`👑 <b>The OG</b>\n├ Bonk ($TOK)\n└ <code>${WSOL}</code>`);
  });

  it("keeps the crown for a caution token and reports the findings", () => {
    const payload = scanOf(
      dangerToken({
        safetyLevel: "caution",
        safetyFlags: ["mutable-metadata"],
      })
    );
    const blocks = formatMintVerdict(BONK, payload).split("\n\n");
    expect(blocks[0]).toBe(
      `👑 <b>Bonk</b> ($BONK)\n└ <b>THE OG</b> · ${age(OG_CREATED)} · #1 of 1`
    );
    expect(blocks.at(-1)).toBe(
      "🔒 <b>Security</b>\n└ <code>Risk  </code> ⚠️ metadata still mutable"
    );
  });

  it("reports 'clear' as an absence of findings, never as safe", () => {
    const payload = scanOf(
      dangerToken({ safetyLevel: "clear", safetyFlags: [] })
    );
    const msg = formatMintVerdict(BONK, payload);
    expect(msg.split("\n\n").at(-1)).toBe(
      "🔒 <b>Security</b>\n└ <code>Risk  </code> 🟢 no blocking flags"
    );
    expect(msg.toLowerCase()).not.toContain("safe");
  });

  it("reports 'unknown' as checks unavailable, never as a clean result", () => {
    const payload = scanOf(
      dangerToken({ safetyLevel: "unknown", safetyFlags: [] })
    );
    const msg = formatMintVerdict(BONK, payload);
    expect(msg.split("\n\n").at(-1)).toBe(
      "🔒 <b>Security</b>\n└ <code>Risk  </code> ❔ checks unavailable"
    );
    expect(msg).not.toContain("no blocking flags");
    // An unrun check must not cost the rank-1 token its crown.
    expect(msg).toContain("👑 <b>Bonk</b> ($BONK)\n└ <b>THE OG</b>");
  });

  it("prints the 24h buy/sell counts on the finding that rests on them", () => {
    const payload = scanOf(
      dangerToken({
        safetyFlags: ["no-sells"],
        buys24h: 212,
        sells24h: 0,
        liquidityUsd: 18_400,
      })
    );
    const msg = formatMintVerdict(BONK, payload);
    expect(msg).toContain("⛔ <b>Blocking</b>\n└ buys but no sells · 212/0");
    expect(msg).toContain("<code>Liq   </code> $18.4K");
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
    const msg = formatMintVerdict(BONK, payload);
    expect(msg).toContain("<code>Auth  </code> ⚠️ freeze active");
    expect(msg).not.toContain("no blocking flags");
    expect(msg).not.toContain("checks unavailable");
  });

  it("flags a top-10 share at or above the concentration threshold", () => {
    const at = (pct: number) =>
      formatMintVerdict(BONK, scanOf(dangerToken({ topHolderPct: pct })));
    expect(at(94)).toContain("<code>Top 10</code> 94% ⚠️");
    expect(at(CONCENTRATION_PCT)).toContain(`<code>Top 10</code> ${CONCENTRATION_PCT}% ⚠️`);
    expect(at(38)).toContain("<code>Top 10</code> 38%");
    expect(at(38)).not.toContain("38% ⚠️");
  });
});

describe("formatBlockingRows / formatSafetyRiskChip", () => {
  it("orders blocking findings first and drops unknown codes", () => {
    const t = tok({
      mint: BONK,
      safetyFlags: [
        "mint-authority",
        "bogus-code" as never,
        "permanent-delegate",
      ],
    });
    expect(formatBlockingRows(t)).toEqual(["permanent delegate set"]);
    expect(formatSafetyRiskChip({ ...t, safetyLevel: "danger" })).toBe(
      "⚠️ mint authority active"
    );
  });

  it("returns nothing when nothing blocks and when the token was never assessed", () => {
    expect(formatBlockingRows(tok({ mint: BONK }))).toEqual([]);
    expect(
      formatBlockingRows(tok({ mint: BONK, safetyFlags: ["low-liquidity"] }))
    ).toEqual([]);
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
    expect(line).toBe("<code>7cJM…TgLq</code>");
  });

  it("flags serial deployers at the ≥10 threshold, plain count below", () => {
    const at = (n: number) =>
      formatDeployerLine(
        tok({ mint: BONK, deployerAddress: DEV, deployerTokensCreated: n }),
        NOW
      );
    expect(at(9)).toBe("<code>7cJM…TgLq</code> · 9 launches");
    expect(at(10)).toBe("<code>7cJM…TgLq</code> · ⚠️ 10 launches");
    expect(at(1)).toBe("<code>7cJM…TgLq</code> · 1 launch");
    // The Enhanced-API count is one page — the cap reads as "or more".
    expect(at(100)).toBe("<code>7cJM…TgLq</code> · ⚠️ 100+ launches");
  });

  it("flags fresh wallets (<7d) and shows the year for older ones", () => {
    const at = (ms: number) =>
      formatDeployerLine(
        tok({ mint: BONK, deployerAddress: DEV, deployerWalletFirstSeenMs: ms }),
        NOW
      );
    expect(at(NOW - 6 * DAY)).toBe("<code>7cJM…TgLq</code> · ⚠️ new wallet");
    // Boundary: exactly 7 days is no longer fresh.
    expect(at(NOW - 7 * DAY)).toBe("<code>7cJM…TgLq</code> · 2026");
    expect(at(Date.parse("2022-03-01T00:00:00.000Z"))).toBe(
      "<code>7cJM…TgLq</code> · 2022"
    );
  });

  it("renders 'established' when history is too deep to date", () => {
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
    expect(line).toBe("<code>7cJM…TgLq</code> · ⚠️ 12 launches · established");
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
        "🕰 <b>Bonk</b> ($BONK)\n└ <b>OLDEST BY AGE</b> · checked today",
        "📋 <b>Registry</b>\n├ safety checks still running\n└ full verdict next",
      ].join("\n\n")
    );
    // The endorsement belongs to the full scan, which has the safety verdict.
    expect(msg).not.toContain("👑");
    expect(msg).not.toMatch(/\bTHE OG\b/);
  });

  it("flags a non-OG with the registered OG's mint and mint date", () => {
    expect(formatRegistryVerdict(USDC, entry())).toBe(
      [
        "🚫 <b>NOT THE OG</b>",
        "👑 <b>The OG</b>\n├ Bonk ($BONK)\n" +
          `├ <code>Born  </code> Dec 20, 2022\n└ <code>${BONK}</code>`,
        "📋 <b>Registry</b>\n└ full re-check running",
      ].join("\n\n")
    );
  });

  it("omits the mint date when unknown and escapes HTML in name/symbol", () => {
    const msg = formatRegistryVerdict(
      USDC,
      entry({ ogName: "Bonk <&> Co", ogSymbol: "B&NK", ogCreatedAtMs: null })
    );
    expect(msg).toContain("├ Bonk &lt;&amp;&gt; Co ($B&amp;NK)");
    expect(msg).not.toContain("Born");
    expect(msg).toContain(`<code>${BONK}</code>`);
  });

  it("omits the symbol suffix when null", () => {
    const msg = formatRegistryVerdict(BONK, entry({ ogSymbol: null }));
    expect(msg).toContain("🕰 <b>Bonk</b>\n└ <b>OLDEST BY AGE</b>");
    expect(msg).not.toContain("$"); // no empty "($)" suffix left behind
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
    expect(formatNameSearchReply("bonk", results)).toBe(
      [
        "🔎 <b>“bonk”</b>\n└ <b>OLDEST MATCH</b> · 4 tokens",
        [
          "👑 <b>Likely OG</b>",
          "├ Bonk ($BONK)",
          `├ <code>Born  </code> Dec 20, 2022 · ${age(OG_CREATED)}`,
          `└ <code>${BONK}</code>`,
        ].join("\n"),
        [
          "📋 <b>Runners-up</b>",
          "├ <code>#2    </code> Bonk 2.0 ($BONK2) · May 1, 2023",
          "└ <code>#3    </code> Bonk Inu ($BINU) · age unknown",
        ].join("\n"),
      ].join("\n\n")
    );
  });

  it("handles a single result and no results", () => {
    const one = [
      tok({ mint: WSOL, displayName: "Sol", displaySymbol: "SOL", rank: 1 }),
    ];
    const single = formatNameSearchReply("sol", one);
    // header + pick — the runners-up section is absent entirely.
    expect(single.split("\n\n")).toHaveLength(2);
    expect(single).not.toContain("#2");
    expect(single).toContain("1 token");
    // An undatable leader is itself an unproven order — never crowned.
    expect(single).not.toContain("👑");
    expect(formatNameSearchReply("nope coin", [])).toBe(
      "🔎 <b>“nope coin”</b>\n└ no tokens found"
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
    const msg = formatNameSearchReply("bonk", results);
    const blocks = msg.split("\n\n");
    expect(blocks[0]).toBe(
      "🛑 <b>“bonk”</b>\n└ <b>UNSAFE — DO NOT BUY</b> · 2 tokens · uncrowned"
    );
    expect(blocks[1]).toBe("⛔ <b>Blocking</b>\n└ new accounts start frozen");
    // The pick section keeps every fact — name, symbol, date, mint — and loses
    // only the crown the header just refused.
    expect(blocks[2]).toBe(
      [
        "🕰 <b>Oldest match</b>",
        "├ Bonk ($BONK)",
        `├ <code>Born  </code> Dec 20, 2022 · ${age(OG_CREATED)}`,
        `└ <code>${BONK}</code>`,
      ].join("\n")
    );
    expect(msg).not.toContain("👑");
    expect(msg).not.toMatch(/\bTHE OG\b/);
    // Ranking below it is unchanged — the list is still factual.
    expect(msg).toContain("<code>#2    </code> Bonk 2.0");
  });

  it("withholds the crown when a match below is still a lower bound", () => {
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
        rank: 2,
        createdAt: CLONE_CREATED,
        createdAtMs: Date.parse(CLONE_CREATED),
        createdAtIsLowerBound: true,
      }),
    ];
    const msg = formatNameSearchReply("bonk", results);
    const blocks = msg.split("\n\n");
    expect(blocks[0]).toBe(
      "🕰 <b>“bonk”</b>\n└ <b>OLDEST KNOWN</b> · 2 tokens · ⏳ 1 unverified"
    );
    expect(blocks[1]).toBe(
      [
        "🕰 <b>Oldest known</b>",
        "├ Bonk ($BONK)",
        `├ <code>Born  </code> Dec 20, 2022 · ${age(OG_CREATED)}`,
        `└ <code>${BONK}</code>`,
      ].join("\n")
    );
    expect(msg).not.toContain("👑");
    expect(msg).not.toMatch(/\bTHE OG\b/);
    // The bounded runner-up says so on its own row as well.
    expect(blocks[2]).toBe(
      "📋 <b>Runners-up</b>\n└ <code>#2    </code> Bonk 2.0 ($TOK) · ≤ May 1, 2023"
    );
  });

  it("keeps the crown when every match is exactly dated", () => {
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
        rank: 2,
        createdAt: CLONE_CREATED,
        createdAtMs: Date.parse(CLONE_CREATED),
      }),
    ];
    expect(formatNameSearchReply("bonk", results)).toContain(
      "👑 <b>Likely OG</b>\n├ Bonk ($BONK)"
    );
  });

  it("escapes HTML in the query and token fields", () => {
    const msg = formatNameSearchReply("a<b>", [
      tok({ mint: WSOL, displayName: "<X> & Co", displaySymbol: "A&B", rank: 1 }),
    ]);
    // The query is escaped in the header…
    expect(msg).toContain("<b>“a&lt;b&gt;”</b>");
    // …name and symbol are escaped in the pick row…
    expect(msg).toContain("├ &lt;X&gt; &amp; Co ($A&amp;B)");
    // …and no raw tag from either field survives anywhere in the message.
    expect(msg).not.toContain("<X>");
    expect(msg).not.toContain("A&B");
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

// ————————————————————— dismiss button (callback_query) —————————————————————

/**
 * Fresh module graph WITH a token and a stubbed global fetch, so the Bot API
 * calls the router makes are observable. `deleteStatus` lets a test make
 * deleteMessage fail exactly as Telegram does for a message past the 48h
 * window (HTTP 400).
 */
async function freshTelegramWithApi(deleteStatus = 200) {
  vi.resetModules();
  process.env.OGFINDER_DB_PATH = ":memory:";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const status = method === "deleteMessage" ? deleteStatus : 200;
    return {
      ok: status === 200,
      status,
      json: async () => ({ ok: status === 200, result: true }),
    } as unknown as Response;
  });
  const telegram = await import("@/lib/telegram");
  return { telegram, calls };
}

describe("dismiss button", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("deletes the bot's own message and answers the query", async () => {
    const { telegram, calls } = await freshTelegramWithApi();
    await telegram.handleTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: "cq1",
        data: telegram.DELETE_CALLBACK_DATA,
        message: { message_id: 42, chat: { id: -100123 } },
      },
    });
    expect(calls.map((c) => c.method)).toEqual([
      "deleteMessage",
      "answerCallbackQuery",
    ]);
    expect(calls[0].body).toEqual({ chat_id: "-100123", message_id: 42 });
    // Deleted cleanly → a bare acknowledgement, no toast.
    expect(calls[1].body).toEqual({ callback_query_id: "cq1" });
  });

  it("still answers — with a reason — when the delete fails", async () => {
    const { telegram, calls } = await freshTelegramWithApi(400);
    await telegram.handleTelegramUpdate({
      update_id: 2,
      callback_query: {
        id: "cq2",
        data: telegram.DELETE_CALLBACK_DATA,
        message: { message_id: 7, chat: { id: 555 } },
      },
    });
    // The query is ALWAYS answered — an unanswered one spins in the client.
    expect(calls.at(-1)).toEqual({
      method: "answerCallbackQuery",
      body: { callback_query_id: "cq2", text: "Too old to delete" },
    });
  });

  it("is a no-op for any callback data it does not recognise", async () => {
    const { telegram, calls } = await freshTelegramWithApi();
    await telegram.handleTelegramUpdate({
      update_id: 3,
      callback_query: {
        id: "cq3",
        data: "someone-elses-payload",
        message: { message_id: 42, chat: { id: -100123 } },
      },
    });
    // Acknowledged, but nothing is deleted.
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });

  it("ignores a callback with no id and one with no message", async () => {
    const { telegram, calls } = await freshTelegramWithApi();
    await telegram.handleTelegramUpdate({
      update_id: 4,
      callback_query: { data: telegram.DELETE_CALLBACK_DATA },
    });
    expect(calls).toEqual([]);
    await telegram.handleTelegramUpdate({
      update_id: 5,
      callback_query: { id: "cq5", data: telegram.DELETE_CALLBACK_DATA },
    });
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
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

// ————————— formatMintVerdict / name reply: derivative names —————————

describe("bot verdicts never crown a derivative name", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a relatedOnly scanned mint at rank 1 prints no crown and no THE OG", () => {
    // Unreachable in production — the scanned mint is never flagged
    // relatedOnly and related tokens sort to the tail — so this is the same
    // defence in depth the danger and unproven branches get.
    const payload: MintScanPayload = {
      results: [
        tok({
          mint: BONK,
          displayName: "BONKMONEY",
          displaySymbol: "BONKM",
          rank: 1,
          createdAt: OG_CREATED,
          createdAtMs: Date.parse(OG_CREATED),
          relatedOnly: true,
        }),
      ],
      query: "bonk",
      scanName: "BONKMONEY",
      scanSymbol: "BONKM",
    };
    const msg = formatMintVerdict(BONK, payload);
    expect(msg).not.toContain("👑");
    expect(msg).not.toMatch(/\bTHE OG\b/);
    // The rank fact survives — only the endorsement is withheld.
    expect(msg.split("\n\n")[0]).toBe(
      `🕰 <b>BONKMONEY</b> ($BONKM)\n└ <b>OLDEST KNOWN</b> · ${age(OG_CREATED)} · #1 of 1`
    );
  });

  it("an eligible rank 1 still gets the crown with related tokens below it", () => {
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
        tok({
          mint: USDC,
          displayName: "BONKMONEY",
          rank: 2,
          createdAt: CLONE_CREATED,
          createdAtMs: Date.parse(CLONE_CREATED),
          relatedOnly: true,
        }),
      ],
      query: "bonk",
      scanName: "Bonk",
      scanSymbol: "BONK",
    };
    expect(formatMintVerdict(BONK, payload)).toContain("<b>THE OG</b>");
  });

  it("/og <name> withholds the crown when every match is derivative", () => {
    const msg = formatNameSearchReply("bonk", [
      tok({
        mint: BONK,
        displayName: "BONKMONEY",
        displaySymbol: "BONKM",
        rank: 1,
        createdAt: OG_CREATED,
        createdAtMs: Date.parse(OG_CREATED),
        relatedOnly: true,
      }),
    ]);
    expect(msg).not.toContain("👑");
    expect(msg).toContain("<b>OLDEST KNOWN</b>");
  });
});
