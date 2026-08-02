import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  consumeRateLimit,
  registerPrepaidSearch,
  consumePrepaidSearch,
} from "@/lib/rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("token bucket", () => {
  it("allows the burst then denies with a retry hint", () => {
    const ip = "bucket-test-1";
    for (let i = 0; i < 10; i++) {
      expect(consumeRateLimit(ip).allowed).toBe(true);
    }
    const denied = consumeRateLimit(ip);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills over time", () => {
    const ip = "bucket-test-2";
    for (let i = 0; i < 10; i++) consumeRateLimit(ip);
    expect(consumeRateLimit(ip).allowed).toBe(false);

    vi.advanceTimersByTime(60_000); // 30/min → full refill of burst 10 in 20s
    expect(consumeRateLimit(ip).allowed).toBe(true);
  });
});

describe("prepaid searches", () => {
  it("is single-use", () => {
    registerPrepaidSearch("ip-a", "bonk");
    expect(consumePrepaidSearch("ip-a", "bonk")).toBe(true);
    expect(consumePrepaidSearch("ip-a", "bonk")).toBe(false);
  });

  it("is scoped to the registering IP and query", () => {
    registerPrepaidSearch("ip-b", "bonk");
    expect(consumePrepaidSearch("ip-c", "bonk")).toBe(false);
    expect(consumePrepaidSearch("ip-b", "wif")).toBe(false);
    expect(consumePrepaidSearch("ip-b", "bonk")).toBe(true);
  });

  it("expires after 60s", () => {
    registerPrepaidSearch("ip-d", "bonk");
    vi.advanceTimersByTime(61_000);
    expect(consumePrepaidSearch("ip-d", "bonk")).toBe(false);
  });

  it("ignores empty keys", () => {
    registerPrepaidSearch("ip-e", "");
    expect(consumePrepaidSearch("ip-e", "")).toBe(false);
  });
});
