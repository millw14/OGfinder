import { describe, it, expect } from "vitest";
import {
  parseStartPayload,
  parseTelegramCommand,
  formatCloneAlertMessage,
  formatFlipAlertMessage,
  actionKeyboard,
  mintKeyboard,
  row,
  DELETE_CALLBACK_DATA,
  WELCOME_HTML,
  HELP_HTML,
} from "@/lib/telegram";

const HEX = "a".repeat(32);

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
  it("renders the token as the header and the facts as a tree section", () => {
    const msg = formatCloneAlertMessage({
      displayQuery: "Pepe",
      name: "Pepe 2.0",
      symbol: "PEPE2",
      source: "dexscreener",
      mint: "Mint123",
    });
    expect(msg).toBe(
      [
        "🚨 <b>Pepe 2.0</b> ($PEPE2)\n└ <b>NEW CLONE</b> · “Pepe”",
        "🔎 <b>Spotted</b>\n" +
          "├ <code>Via   </code> dexscreener\n" +
          "└ <code>Mint123</code>",
      ].join("\n\n")
    );
    // The label column is padded INSIDE the code entity — that is the only
    // place Telegram renders monospace, so the value column can line up.
    expect(msg).toContain("<code>Via   </code>");
    // Last row of a section always closes the tree.
    expect(msg.split("\n").at(-1)).toMatch(/^└ /);
  });

  it("omits an absent source/mint and degrades to the header alone", () => {
    const msg = formatCloneAlertMessage({
      displayQuery: "Pepe",
      name: null,
      symbol: null,
      source: null,
      mint: null,
    });
    // Nothing known but the watch: the alert kind leads and no empty section
    // (or empty label, or dash-value row) is rendered.
    expect(msg).toBe("🚨 <b>NEW CLONE</b>\n└ “Pepe”");
    expect(msg.split("\n\n")).toHaveLength(1);
  });

  it("escapes HTML in the query, name, symbol, and source", () => {
    const msg = formatCloneAlertMessage({
      displayQuery: "a<b> & co",
      name: "<script>x</script>",
      symbol: "A&B",
      source: "<src>",
      mint: null,
    });
    expect(msg).toBe(
      [
        "🚨 <b>&lt;script&gt;x&lt;/script&gt;</b> ($A&amp;B)\n" +
          "└ <b>NEW CLONE</b> · “a&lt;b&gt; &amp; co”",
        "🔎 <b>Spotted</b>\n└ <code>Via   </code> &lt;src&gt;",
      ].join("\n\n")
    );
    expect(msg).not.toContain("<script>");
  });

  it("escapes an injected mint inside its code row", () => {
    const msg = formatCloneAlertMessage({
      displayQuery: "Pepe",
      name: "Pepe",
      symbol: null,
      source: null,
      mint: '"><b>x',
    });
    // Telegram HTML only needs &, <, > escaped; the quote is inert in a text node.
    expect(msg).toContain('<code>"&gt;&lt;b&gt;x</code>');
    expect(msg).not.toContain('"><b>x');
  });
});

describe("formatFlipAlertMessage", () => {
  it("renders the payload message escaped, with the mint as a copy row", () => {
    const msg = formatFlipAlertMessage({
      displayQuery: "Pepe",
      name: "Pepe OG",
      symbol: "PEPE",
      source: null,
      mint: "MintOG",
      payload: { message: "Volume flipped <up>" },
    });
    expect(msg).toBe(
      [
        "🔁 <b>Pepe OG</b> ($PEPE)\n└ <b>WATCH UPDATE</b> · “Pepe”",
        "ℹ️ <b>Update</b>\n├ Volume flipped &lt;up&gt;\n└ <code>MintOG</code>",
      ].join("\n\n")
    );
  });

  it("falls back to a generic header when payload/mint/name are absent", () => {
    const msg = formatFlipAlertMessage({
      displayQuery: "Pepe & co",
      name: null,
      symbol: null,
      source: null,
      mint: null,
      payload: "not-an-object",
    });
    // Header only — no blank-line-separated empty blocks.
    expect(msg).toBe("🔁 <b>WATCH UPDATE</b>\n└ “Pepe &amp; co”");
  });

  it("keeps a symbol that arrives without a name", () => {
    const msg = formatFlipAlertMessage({
      displayQuery: "Pepe",
      name: null,
      symbol: "PEPE",
      source: null,
      mint: null,
    });
    expect(msg).toBe(
      "🔁 <b>Unnamed token</b> ($PEPE)\n└ <b>WATCH UPDATE</b> · “Pepe”"
    );
  });
});

// ————————————————————————— tree primitives —————————————————————————

describe("row / actionKeyboard", () => {
  it("pads every label to one width INSIDE the code entity", () => {
    expect(row("MC", "$2.3B")).toBe("├ <code>MC    </code> $2.3B");
    expect(row("Top 10", "38%", true)).toBe("└ <code>Top 10</code> 38%");
    // An empty label renders the value alone — never an empty code block.
    expect(row("", "freeze authority active", true)).toBe(
      "└ freeze authority active"
    );
    // All labels are the same width, so the value column lines up.
    const widths = ["MC", "Liq", "24H", "Auth", "Top 10", "Dev", "Born"].map(
      (l) => row(l, "x").indexOf("</code>")
    );
    expect(new Set(widths).size).toBe(1);
  });

  it("builds the action row + a delete row, dropping missing URLs", () => {
    expect(
      actionKeyboard({ verdict: "https://a", chart: "https://b", trade: "https://c" })
    ).toEqual({
      inline_keyboard: [
        [
          { text: "👑 Verdict", url: "https://a" },
          { text: "📈 Chart", url: "https://b" },
          { text: "💱 Trade", url: "https://c" },
        ],
        [{ text: "🗑 Delete", callback_data: DELETE_CALLBACK_DATA }],
      ],
    });
    // No URLs at all → the dismiss button still ships, alone.
    expect(actionKeyboard({})).toEqual({
      inline_keyboard: [
        [{ text: "🗑 Delete", callback_data: DELETE_CALLBACK_DATA }],
      ],
    });
    // Telegram caps callback_data at 64 bytes.
    expect(Buffer.byteLength(DELETE_CALLBACK_DATA)).toBeLessThanOrEqual(64);
  });

  it("percent-encodes the mint into both link buttons", () => {
    const kb = mintKeyboard('"><b>x', "https://site/?q=1");
    expect(kb.inline_keyboard[0][1].url).toBe(
      "https://dexscreener.com/solana/%22%3E%3Cb%3Ex"
    );
    expect(kb.inline_keyboard[0][2].url).toBe(
      "https://trade.padre.gg/trade/solana/%22%3E%3Cb%3Ex"
    );
    expect(JSON.stringify(kb)).not.toContain('"><b>x');
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
