import { describe, it, expect } from "vitest";
import { coalesce } from "@/lib/scan";

/**
 * coalesce() is the process-wide in-flight map shared by the HTTP route and
 * lib callers (scanMint). Pin its contract: concurrent same-key calls share
 * one run; the slot clears after settle (resolve OR reject) so later calls
 * run fresh; distinct keys never share.
 */
describe("coalesce", () => {
  it("shares one in-flight run across concurrent same-key callers", async () => {
    let runs = 0;
    let release!: (v: string) => void;
    const gate = new Promise<string>((res) => {
      release = res;
    });
    const fn = () => {
      runs++;
      return gate;
    };

    const a = coalesce("scan-test:same", fn);
    const b = coalesce("scan-test:same", fn);
    release("done");
    expect(await a).toBe("done");
    expect(await b).toBe("done");
    expect(runs).toBe(1);
  });

  it("clears the slot after resolution so later calls run fresh", async () => {
    let runs = 0;
    const fn = async () => ++runs;
    expect(await coalesce("scan-test:fresh", fn)).toBe(1);
    expect(await coalesce("scan-test:fresh", fn)).toBe(2);
  });

  it("clears the slot after rejection (no poisoned cache of failures)", async () => {
    let runs = 0;
    await expect(
      coalesce("scan-test:reject", async () => {
        runs++;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await coalesce("scan-test:reject", async () => ++runs)).toBe(2);
  });

  it("does not share runs across distinct keys", async () => {
    let runs = 0;
    const fn = async () => ++runs;
    const [a, b] = await Promise.all([
      coalesce("scan-test:key-a", fn),
      coalesce("scan-test:key-b", fn),
    ]);
    expect(new Set([a, b]).size).toBe(2);
    expect(runs).toBe(2);
  });
});
