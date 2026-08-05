import { describe, it, expect } from "vitest";
import {
  encodeSharePayload,
  decodeSharePayload,
  encodeComparePayload,
  decodeComparePayload,
  encodeSafetyMarker,
  decodeSafetyMarker,
  SharePayload,
  ComparePayload,
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

describe("safety marker (?sf=)", () => {
  it("round-trips a blocking flag code", () => {
    expect(decodeSafetyMarker(encodeSafetyMarker("freeze-authority"))).toBe(
      "freeze-authority"
    );
    expect(decodeSafetyMarker(encodeSafetyMarker("transfer-hook"))).toBe(
      "transfer-hook"
    );
  });

  it("refuses caution codes — only a blocking finding earns the red band", () => {
    expect(decodeSafetyMarker("mint-authority")).toBeNull();
    expect(decodeSafetyMarker("mutable-metadata")).toBeNull();
    expect(decodeSafetyMarker("few-sells")).toBeNull();
  });

  it("rejects malformed / absent input", () => {
    expect(decodeSafetyMarker(null)).toBeNull();
    expect(decodeSafetyMarker(undefined)).toBeNull();
    expect(decodeSafetyMarker("")).toBeNull();
    expect(decodeSafetyMarker("not-a-code")).toBeNull();
    expect(decodeSafetyMarker("x".repeat(64))).toBeNull();
    expect(decodeSafetyMarker("__proto__")).toBeNull();
    expect(decodeSafetyMarker("constructor")).toBeNull();
    expect(decodeSafetyMarker(5 as unknown as string)).toBeNull();
  });

  it("leaves the ?v= contract alone — old links decode byte for byte", () => {
    // The marker is a SIBLING param: adding it changes nothing about how a
    // previously minted verdict payload encodes or decodes.
    const encoded = encodeSharePayload(base);
    expect(decodeSharePayload(encoded)).toEqual(base);
    // …and a marker value is not itself a verdict payload.
    expect(decodeSharePayload("freeze-authority")).toBeNull();
  });
});

const compareBase: ComparePayload = {
  a: {
    n: "Bonk",
    s: "BONK",
    d: "2022-12-20",
    m: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  },
  b: {
    n: "dogwifhat",
    s: "WIF",
    d: "2023-11-15",
    m: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  w: 0,
};

describe("compare payload (?cv=)", () => {
  it("round-trips encode → decode", () => {
    const decoded = decodeComparePayload(encodeComparePayload(compareBase));
    expect(decoded).toEqual(compareBase);
  });

  it("round-trips w = 1 and w = null", () => {
    expect(
      decodeComparePayload(encodeComparePayload({ ...compareBase, w: 1 }))!.w
    ).toBe(1);
    expect(
      decodeComparePayload(encodeComparePayload({ ...compareBase, w: null }))!.w
    ).toBeNull();
  });

  it("truncates names to 24 and slices dates to 10 chars", () => {
    const decoded = decodeComparePayload(
      encodeComparePayload({
        ...compareBase,
        a: {
          ...compareBase.a,
          n: "X".repeat(200),
          s: "Y".repeat(200),
          d: "2022-12-20T21:10:46.000Z",
        },
      })
    );
    expect(decoded!.a.n.length).toBeLessThanOrEqual(24);
    expect(decoded!.a.s.length).toBeLessThanOrEqual(24);
    expect(decoded!.a.d).toBe("2022-12-20");
  });

  it("rejects malformed input", () => {
    expect(decodeComparePayload("")).toBeNull();
    expect(decodeComparePayload("!!!not-base64url!!!")).toBeNull();
    expect(decodeComparePayload("x".repeat(800))).toBeNull(); // over 768 raw cap
    // Missing side
    const noB = Buffer.from(
      JSON.stringify({ a: compareBase.a, w: 0 })
    ).toString("base64url");
    expect(decodeComparePayload(noB)).toBeNull();
    // Wrong side field types
    const badSide = Buffer.from(
      JSON.stringify({
        a: { n: 5, s: "s", d: null, m: "m" },
        b: compareBase.b,
        w: 0,
      })
    ).toString("base64url");
    expect(decodeComparePayload(badSide)).toBeNull();
    // Invalid winner values
    const badW = Buffer.from(
      JSON.stringify({ a: compareBase.a, b: compareBase.b, w: 2 })
    ).toString("base64url");
    expect(decodeComparePayload(badW)).toBeNull();
    const strW = Buffer.from(
      JSON.stringify({ a: compareBase.a, b: compareBase.b, w: "0" })
    ).toString("base64url");
    expect(decodeComparePayload(strW)).toBeNull();
    // Arrays are not payloads
    const arr = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expect(decodeComparePayload(arr)).toBeNull();
  });

  it("keeps the two decoders strict — payloads don't cross-decode", () => {
    // The old ?v= decoder rejects compare payloads (untouched behavior)…
    expect(decodeSharePayload(encodeComparePayload(compareBase))).toBeNull();
    // …and the ?cv= decoder rejects verdict payloads.
    const verdict: SharePayload = {
      n: "Bonk",
      s: "Bonk",
      d: "2022-12-20T21:10:46.000Z",
      r: 1,
      t: 100,
      o: true,
      m: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    };
    expect(decodeComparePayload(encodeSharePayload(verdict))).toBeNull();
  });
});
