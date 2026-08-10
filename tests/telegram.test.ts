import { describe, it, expect } from "vitest";
import {
  parseStartPayload,
  parseTelegramCommand,
  formatCloneAlertMessage,
  formatFlipAlertMessage,
  WELCOME_HTML,
  HELP_HTML,
} from "@/lib/telegram";

const HEX = "a".repeat(32);
const SITE = "https://ogfinder.example";

describe("parseStartPayload", () => {
  it("accepts w_<id>_<32hex> and extracts the parts", () => {
    expect(parseStartPayload(`w_12_${HEX}`)).toEqual({
      watchId: 12,
      secret: HEX,
    });
    expect(parseStartPayload(`w_1_${"0123456789abcdef".repeat(2)}`)).toEqual({
      watchId: 1,
      secret: "0123456789abcdef".repeat(2),
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseStartPayload("")).toBeNull();
    expect(parseStartPayload("w_")).toBeNull();
    expect(parseStartPayload(HEX)).toBeNull();
    // id must be a positive integer without leading zeros.
    expect(parseStartPayload(`w_0_${HEX}`)).toBeNull();
    expect(parseStartPayload(`w_007_${HEX}`)).toBeNull();
    expect(parseStartPayload(`w_-3_${HEX}`)).toBeNull();
    expect(parseStartPayload(`w_${"9".repeat(11)}_${HEX}`)).toBeNull();
    // secret must be exactly 32 lowercase hex chars.
    expect(parseStartPayload(`w_12_${"a".repeat(31)}`)).toBeNull();
    expect(parseStartPayload(`w_12_${"a".repeat(33)}`)).toBeNull();
    expect(parseStartPayload(`w_12_${"A".repeat(32)}`)).toBeNull();
    expect(parseStartPayload(`w_12_${"z".repeat(32)}`)).toBeNull();
    // wrong prefix / trailing junk.
    expect(parseStartPayload(`x_12_${HEX}`)).toBeNull();
    expect(parseStartPayload(`w_12_${HEX}_extra`)).toBeNull();
    expect(parseStartPayload(` w_12_${HEX}`)).toBeNull();
  });
});

describe("parseTelegramCommand", () => {
  it("parses /start with and without a payload arg", () => {
    expect(parseTelegramCommand(`/start w_12_${HEX}`)).toEqual({
      command: "start",
      arg: `w_12_${HEX}`,
    });
    expect(parseTelegramCommand("/start")).toEqual({
      command: "start",
      arg: null,
    });
  });

  it("handles the @BotName suffix and surrounding whitespace", () => {
    expect(parseTelegramCommand(`/start@OGFinderBot w_1_${HEX}`)).toEqual({
      command: "start",
      arg: `w_1_${HEX}`,
    });
    expect(parseTelegramCommand("  /stop  ")).toEqual({
      command: "stop",
      arg: null,
    });
    expect(parseTelegramCommand("/list@OGFinderBot")).toEqual({
      command: "list",
      arg: null,
    });
  });

  it("rejects non-commands and unknown commands", () => {
    expect(parseTelegramCommand("hello")).toBeNull();
    expect(parseTelegramCommand("/starting")).toBeNull();
    expect(parseTelegramCommand("/help")).toBeNull();
    expect(parseTelegramCommand("")).toBeNull();
  });
});

describe("formatCloneAlertMessage", () => {
  it("renders name, symbol, source, and both links", () => {
    const msg = formatCloneAlertMessage(
      {
        displayQuery: "Pepe",
        name: "Pepe 2.0",
        symbol: "PEPE2",
        source: "dexscreener",
        mint: "Mint123",
      },
      SITE
    );
    // Block layout: headline · subject (identity + facts) · actions.
    expect(msg).toBe(
      [
        "🚨 <b>NEW CLONE</b> · “Pepe”",
        "<b>Pepe 2.0</b> ($PEPE2)\n🔎 spotted via dexscreener\n<code>Mint123</code>",
        `<a href="${SITE}/?q=Mint123">Verdict card</a> · ` +
          '<a href="https://dexscreener.com/solana/Mint123">Chart</a>',
      ].join("\n\n")
    );
    // Both original link targets survive the restyle.
    expect(msg).toContain(`${SITE}/?q=Mint123`);
    expect(msg).toContain("https://dexscreener.com/solana/Mint123");
  });

  it("omits missing symbol/source and links without a mint", () => {
    const msg = formatCloneAlertMessage(
      {
        displayQuery: "Pepe",
        name: null,
        symbol: null,
        source: null,
        mint: null,
      },
      SITE
    );
    expect(msg).toBe("🚨 <b>NEW CLONE</b> · “Pepe”\n\n<b>Unnamed token</b>");
    // No mint → no actions block, and never an empty trailing block.
    expect(msg.split("\n\n")).toHaveLength(2);
  });

  it("escapes HTML in the query, name, symbol, and source", () => {
    const msg = formatCloneAlertMessage(
      {
        displayQuery: "a<b> & co",
        name: "<script>x</script>",
        symbol: "A&B",
        source: "<src>",
        mint: null,
      },
      SITE
    );
    expect(msg).toBe(
      [
        "🚨 <b>NEW CLONE</b> · “a&lt;b&gt; &amp; co”",
        "<b>&lt;script&gt;x&lt;/script&gt;</b> ($A&amp;B)\n🔎 spotted via &lt;src&gt;",
      ].join("\n\n")
    );
    expect(msg).not.toContain("<script>");
  });

  it("escapes an injected mint in both the code block and the links", () => {
    const msg = formatCloneAlertMessage(
      {
        displayQuery: "Pepe",
        name: "Pepe",
        symbol: null,
        source: null,
        mint: '"><b>x',
      },
      SITE
    );
    // Telegram HTML only needs &, <, > escaped; the quote is inert in a text node.
    expect(msg).toContain('<code>"&gt;&lt;b&gt;x</code>');
    // …and the same value is percent-encoded inside both hrefs.
    expect(msg).toContain(`${SITE}/?q=%22%3E%3Cb%3Ex`);
    expect(msg).not.toContain('"><b>x');
  });
});

describe("formatFlipAlertMessage", () => {
  it("renders the payload message escaped, with a site link when mint set", () => {
    const msg = formatFlipAlertMessage(
      {
        displayQuery: "Pepe",
        name: "Pepe OG",
        symbol: "PEPE",
        source: null,
        mint: "MintOG",
        payload: { message: "Volume flipped <up>" },
      },
      SITE
    );
    expect(msg).toBe(
      [
        "🔁 <b>WATCH UPDATE</b> · “Pepe”",
        "<b>Pepe OG</b> ($PEPE)\nℹ️ Volume flipped &lt;up&gt;\n<code>MintOG</code>",
        `<a href="${SITE}/?q=MintOG">Verdict card</a>`,
      ].join("\n\n")
    );
  });

  it("falls back to a generic header when payload/mint/name are absent", () => {
    const msg = formatFlipAlertMessage(
      {
        displayQuery: "Pepe & co",
        name: null,
        symbol: null,
        source: null,
        mint: null,
        payload: "not-an-object",
      },
      SITE
    );
    // Headline only — no blank-line-separated empty blocks.
    expect(msg).toBe("🔁 <b>WATCH UPDATE</b> · “Pepe &amp; co”");
  });

  it("keeps a symbol that arrives without a name", () => {
    const msg = formatFlipAlertMessage(
      {
        displayQuery: "Pepe",
        name: null,
        symbol: "PEPE",
        source: null,
        mint: null,
      },
      SITE
    );
    expect(msg).toBe(
      "🔁 <b>WATCH UPDATE</b> · “Pepe”\n\n<b>Unnamed token</b> ($PEPE)"
    );
  });
});

// ————————————————————————— WELCOME_HTML / HELP_HTML —————————————————————————

describe("WELCOME_HTML", () => {
  it("is a block layout: headline, what it does, commands, honesty note", () => {
    const blocks = WELCOME_HTML.split("\n\n");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toBe("👑 <b>OGfinder is live in this chat</b>");
    // Commands are their own block, one per line.
    expect(blocks[2].split("\n")).toEqual([
      "/og &lt;mint or name&gt; — OG-check a CA or a token name",
      "/watch &lt;name&gt; — new-clone alerts for a name in this chat",
      "/help — everything I check, in detail",
    ]);
  });

  it("keeps every fact the old one-liner carried", () => {
    for (const fact of [
      "Solana CA",
      "age rank",
      "market data",
      "freeze authority",
      "Token-2022 transfer hooks and fees",
      "24h buys vs sells",
      "blocking flag is never called the OG",
    ]) {
      expect(WELCOME_HTML).toContain(fact);
    }
  });

  it("says an OG verdict is about age, not safety, in its own last block", () => {
    const last = WELCOME_HTML.split("\n\n").at(-1)!;
    expect(last).toContain("ORIGINAL BY AGE");
    expect(last).toContain("not that it is safe to buy");
    expect(last).toContain("never investment advice");
  });

  it("escapes the angle brackets in the command placeholders", () => {
    expect(WELCOME_HTML).not.toMatch(/<(mint|name)/);
    expect(WELCOME_HTML).toContain("&lt;mint or name&gt;");
  });
});

describe("HELP_HTML", () => {
  it("is a block layout with the commands in one block", () => {
    const blocks = HELP_HTML.split("\n\n");
    expect(blocks[0]).toBe("<b>OGfinder bot</b> — which token of a name came first.");
    expect(blocks[1].split("\n")).toEqual([
      "/og &lt;mint or name&gt; — OG-check a CA or a token name",
      "/watch &lt;name&gt; — new-clone alerts for a name in this chat (25/day cap)",
      "/watches — list this chat's watches",
      "/unwatch &lt;id or name&gt; — remove a watch",
      "/help — this message",
    ]);
    // Every command the router handles is documented.
    for (const cmd of ["/og", "/watch ", "/watches", "/unwatch", "/help"]) {
      expect(blocks[1]).toContain(cmd);
    }
  });

  it("keeps the paste-a-CA behaviour and the what-I-check list", () => {
    expect(HELP_HTML).toContain(
      "Paste any Solana CA straight into the chat and I'll check it automatically"
    );
    expect(HELP_HTML).toContain("<b>What I check:</b>");
    for (const fact of [
      "on-chain age",
      "mint and freeze authority",
      "transfer hooks, permanent delegate, transfer fees",
      "24h buys vs sells",
      "holder concentration and liquidity",
    ]) {
      expect(HELP_HTML).toContain(fact);
    }
  });

  it("keeps the originality-not-safety note and the never-clean rule", () => {
    expect(HELP_HTML).toContain("ORIGINALITY BY AGE");
    expect(HELP_HTML).toContain("not that it is safe to buy");
    expect(HELP_HTML).toContain("never as clean");
    expect(HELP_HTML).toContain("always do your own research");
  });

  it("keeps the BotFather privacy note verbatim in substance, as the last block", () => {
    const last = HELP_HTML.split("\n\n").at(-1)!;
    expect(last).toContain("If pasted CAs get no reply here");
    expect(last).toContain("can't see plain group messages");
    expect(last).toContain("@BotFather");
    expect(last).toContain("(/setprivacy → Disable)");
    expect(last).toContain("re-add me");
  });

  it("escapes the angle brackets in the command placeholders", () => {
    expect(HELP_HTML).not.toMatch(/<(mint|name|id)/);
    expect(HELP_HTML).toContain("&lt;id or name&gt;");
  });
});
