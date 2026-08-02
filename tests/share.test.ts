import { describe, it, expect } from "vitest";
import {
  encodeSharePayload,
  decodeSharePayload,
  SharePayload,
} from "@/lib/share";

const base: SharePayload = {
  n: "Bonk",
  s: "Bonk",
  d: "2022-12-20T21:10:46.000Z",
  r: 1,
  t: 100,
  o: true,
  m: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};

describe("share payload", () => {
  it("round-trips encode → decode", () => {
    const decoded = decodeSharePayload(encodeSharePayload(base));
    expect(decoded).not.toBeNull();
    expect(decoded!.n).toBe("Bonk");
    expect(decoded!.o).toBe(true);
    expect(decoded!.r).toBe(1);
    expect(decoded!.m).toBe(base.m);
  });

  it("truncates long string fields to 48 chars", () => {
    const decoded = decodeSharePayload(
      encodeSharePayload({ ...base, n: "X".repeat(200) })
    );
    expect(decoded!.n.length).toBeLessThanOrEqual(48);
  });

  it("rejects malformed input", () => {
    expect(decodeSharePayload("")).toBeNull();
    expect(decodeSharePayload("!!!not-base64url!!!")).toBeNull();
    expect(decodeSharePayload("YQ")).toBeNull(); // "a" — not an object
    expect(decodeSharePayload("x".repeat(600))).toBeNull(); // over raw cap
    // Wrong field types
    const bad = Buffer.from(
      JSON.stringify({ n: 5, s: "s", d: null, r: null, t: null, o: true, m: null })
    ).toString("base64url");
    expect(decodeSharePayload(bad)).toBeNull();
    // Arrays are not payloads
    const arr = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expect(decodeSharePayload(arr)).toBeNull();
  });
});
