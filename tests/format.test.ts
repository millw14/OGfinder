import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatAgeAgo,
  formatCompactNumber,
  formatCreatedAt,
  formatSocialLabel,
  formatTokenSupply,
  LOWER_BOUND_PREFIX,
  timeAgo,
} from "@/lib/format";

/**
 * A truncated signature walk proves "this token existed by date T" and nothing
 * more — the real creation is at or before T, by an unknown amount. These two
 * helpers are the single place that wording is decided, so every surface that
 * shows a bounded date says the same honest thing.
 */

const ISO = "2022-12-20T21:10:46.000Z";

describe("formatCreatedAt", () => {
  it("renders an exact date bare and a bounded one prefixed", () => {
    expect(formatCreatedAt(ISO)).toBe("Dec 20, 2022");
    expect(formatCreatedAt(ISO, false)).toBe("Dec 20, 2022");
    expect(formatCreatedAt(ISO, true)).toBe(`${LOWER_BOUND_PREFIX} Dec 20, 2022`);
  });

  it("never prefixes a non-date — 'on or before Unknown' claims something", () => {
    expect(formatCreatedAt(null, true)).toBe("Unknown");
    expect(formatCreatedAt("not-a-date", true)).toBe("—");
  });
});

describe("formatAgeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a bounded date into a MINIMUM age", () => {
    // Creation at or before T ⇒ the token is at least that old. The bound runs
    // the opposite way from the date, and this is the direction we can assert.
    expect(formatAgeAgo(ISO, false)).toBe(timeAgo(ISO));
    expect(formatAgeAgo(ISO, true)).toBe(`at least ${timeAgo(ISO)}`);
  });

  it("stays silent when there is no age to qualify", () => {
    expect(formatAgeAgo(null, true)).toBe("");
    expect(formatAgeAgo("not-a-date", true)).toBe("unknown age");
  });
});

describe("formatCompactNumber", () => {
  it("scales into K/M/B/T/Q", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1_000)).toBe("1K");
    expect(formatCompactNumber(12_500)).toBe("12.5K");
    expect(formatCompactNumber(1_000_000)).toBe("1M");
    expect(formatCompactNumber(1_000_000_000)).toBe("1B");
    expect(formatCompactNumber(1e12)).toBe("1T");
    expect(formatCompactNumber(1e15)).toBe("1Q");
  });

  it("strips the zeros a fixed precision leaves behind", () => {
    // "1.00B" and "1.20B" are noise; the magnitude is the whole point.
    expect(formatCompactNumber(1_200_000_000)).toBe("1.2B");
    expect(formatCompactNumber(1_230_000_000)).toBe("1.23B");
    expect(formatCompactNumber(0)).toBe("0");
  });

  it("drops precision as the mantissa grows, so labels stay short", () => {
    expect(formatCompactNumber(87_994_589_883_380)).toBe("88T");
    expect(formatCompactNumber(15_400_000)).toBe("15.4M");
    expect(formatCompactNumber(1_234_000)).toBe("1.23M");
  });

  it("renders a dash rather than NaN for non-numbers", () => {
    expect(formatCompactNumber(Number.NaN)).toBe("—");
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCompactNumber("1000" as unknown as number)).toBe("—");
  });
});

describe("formatTokenSupply", () => {
  it("decimal-adjusts the raw on-chain supply (live BONK numbers)", () => {
    // DAS reported raw 8799458988338050000 at 5 decimals → ~88 trillion BONK.
    expect(formatTokenSupply(8_799_458_988_338_050_000, 5)).toBe("88T");
    // A pump.fun mint: raw 2e15 at 6 decimals → the familiar 1B supply.
    expect(formatTokenSupply(2_000_000_000_000_000, 6)).toBe("2B");
    expect(formatTokenSupply(1_000_000_000, 0)).toBe("1B");
  });

  it("returns null without decimals — the raw number would be a lie", () => {
    // Rendering BONK's raw supply unadjusted overstates it by 100,000×.
    expect(formatTokenSupply(8_799_458_988_338_050_000, null)).toBeNull();
    expect(formatTokenSupply(8_799_458_988_338_050_000, undefined)).toBeNull();
    expect(formatTokenSupply(1000, 1.5)).toBeNull();
    expect(formatTokenSupply(1000, -1)).toBeNull();
    expect(formatTokenSupply(1000, 99)).toBeNull();
  });

  it("returns null for a missing or nonsensical supply", () => {
    expect(formatTokenSupply(null, 6)).toBeNull();
    expect(formatTokenSupply(undefined, 6)).toBeNull();
    expect(formatTokenSupply(Number.NaN, 6)).toBeNull();
    expect(formatTokenSupply(-5, 6)).toBeNull();
    expect(formatTokenSupply(0, 6)).toBe("0");
  });
});

describe("formatSocialLabel", () => {
  it("labels X and Telegram links with the handle (verified live shapes)", () => {
    expect(formatSocialLabel("https://x.com/Cat_Terminal_")).toBe(
      "@Cat_Terminal_"
    );
    expect(formatSocialLabel("https://twitter.com/bonk_inu")).toBe("@bonk_inu");
    expect(formatSocialLabel("https://t.me/catterminal")).toBe("@catterminal");
    // Deep links keep only the account segment.
    expect(
      formatSocialLabel("https://x.com/vldscorpius/status/1932434634")
    ).toBe("@vldscorpius");
  });

  it("never invents an account out of a site feature", () => {
    // Live case: dogewifmask's "twitter" is an x.com SEARCH for its own name.
    // "@search" would name an account that does not exist, so it falls back
    // to the host — which is all we can honestly say about the link.
    expect(
      formatSocialLabel("https://x.com/search?q=dogewifmask&src=typed_query")
    ).toBe("x.com");
    expect(formatSocialLabel("https://x.com/i/communities/12345")).toBe("x.com");
    expect(formatSocialLabel("https://x.com/intent/follow?screen_name=a")).toBe(
      "x.com"
    );
    expect(formatSocialLabel("https://x.com/hashtag/bonk")).toBe("x.com");
    // Case-insensitively — "/Search" is the same feature.
    expect(formatSocialLabel("https://x.com/Search?q=x")).toBe("x.com");
  });

  it("labels a website with its bare host", () => {
    expect(formatSocialLabel("https://www.cat-terminal.xyz/")).toBe(
      "cat-terminal.xyz"
    );
    expect(formatSocialLabel("https://bonkcoin.com/some/deep/path?a=1")).toBe(
      "bonkcoin.com"
    );
    // A handle host with no path segment has no handle to show.
    expect(formatSocialLabel("https://x.com")).toBe("x.com");
  });

  it("never leaks the raw URL, however long", () => {
    const long = `https://example.com/${"a".repeat(500)}`;
    const label = formatSocialLabel(long)!;
    expect(label).toBe("example.com");
    expect(label).not.toContain("aaaa");
  });

  it("clamps an over-long handle instead of blowing out the row", () => {
    const label = formatSocialLabel(`https://t.me/${"h".repeat(80)}`)!;
    expect(label.length).toBeLessThanOrEqual(28);
    expect(label.endsWith("…")).toBe(true);
  });

  it("strips characters that could disguise a handle", () => {
    // Bidi override + zero-width chars are the classic label spoof; the
    // filter keeps handles to the characters a real one can contain.
    expect(formatSocialLabel("https://x.com/%E2%80%AEevil")).toBe("@evil");
    expect(formatSocialLabel("https://x.com/ab​cd")).toBe("@abcd");
    // Nothing usable left → fall back to the host, never to the raw path.
    expect(formatSocialLabel("https://x.com/%E2%80%AE")).toBe("x.com");
  });

  it("keeps an IDN host punycode-encoded so lookalikes stay visible", () => {
    expect(formatSocialLabel("https://xn--e1afmkfd.xn--p1ai/")).toBe(
      "xn--e1afmkfd.xn--p1ai"
    );
  });

  it("returns null for anything that is not an http(s) URL", () => {
    expect(formatSocialLabel("javascript:alert(1)")).toBeNull();
    expect(formatSocialLabel("data:text/html,<script>")).toBeNull();
    expect(formatSocialLabel("//evil.example.com")).toBeNull();
    expect(formatSocialLabel("not a url")).toBeNull();
    expect(formatSocialLabel("")).toBeNull();
    expect(formatSocialLabel("   ")).toBeNull();
    expect(formatSocialLabel(null)).toBeNull();
    expect(formatSocialLabel(undefined)).toBeNull();
    expect(formatSocialLabel(42)).toBeNull();
  });
});
