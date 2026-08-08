import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatAgeAgo,
  formatCreatedAt,
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
