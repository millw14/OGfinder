import { describe, it, expect } from "vitest";
import {
  parseStartPayload,
  parseTelegramCommand,
  formatCloneAlertMessage,
  formatFlipAlertMessage,
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
    expect(msg).toBe(
      '🚨 New clone of "Pepe": <b>Pepe 2.0</b> ($PEPE2) via dexscreener\n' +
        `${SITE}/?q=Mint123\n` +
        "https://dexscreener.com/solana/Mint123"
    );
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
    expect(msg).toBe('🚨 New clone of "Pepe": <b>Unnamed token</b>');
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
      '🚨 New clone of "a&lt;b&gt; &amp; co": ' +
        "<b>&lt;script&gt;x&lt;/script&gt;</b> ($A&amp;B) via &lt;src&gt;"
    );
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
      '🔁 Watch update for "Pepe": <b>Pepe OG</b> ($PEPE)\n' +
        "Volume flipped &lt;up&gt;\n" +
        `${SITE}/?q=MintOG`
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
    expect(msg).toBe('🔁 Watch update for "Pepe &amp; co"');
  });
});
