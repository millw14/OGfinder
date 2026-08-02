import { describe, it, expect } from "vitest";
import { parseCompareInput } from "@/lib/compare";

const A = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // Bonk
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

describe("parseCompareInput", () => {
  it('parses "A vs B"', () => {
    expect(parseCompareInput(`${A} vs ${B}`)).toEqual({ a: A, b: B });
  });

  it("parses case-insensitive VS and vs.", () => {
    expect(parseCompareInput(`${A} VS ${B}`)).toEqual({ a: A, b: B });
    expect(parseCompareInput(`${A} vs. ${B}`)).toEqual({ a: A, b: B });
  });

  it("parses comma-separated mints (with and without spaces)", () => {
    expect(parseCompareInput(`${A},${B}`)).toEqual({ a: A, b: B });
    expect(parseCompareInput(`${A}, ${B}`)).toEqual({ a: A, b: B });
    expect(parseCompareInput(`${A} , ${B}`)).toEqual({ a: A, b: B });
  });

  it("parses whitespace-separated mints", () => {
    expect(parseCompareInput(`${A} ${B}`)).toEqual({ a: A, b: B });
    expect(parseCompareInput(`${A}   ${B}`)).toEqual({ a: A, b: B });
  });

  it("rejects a single mint", () => {
    expect(parseCompareInput(A)).toBeNull();
  });

  it("rejects identical mints", () => {
    expect(parseCompareInput(`${A} vs ${A}`)).toBeNull();
  });

  it("rejects three parts", () => {
    expect(parseCompareInput(`${A} vs ${B} vs ${A}`)).toBeNull();
  });

  it("rejects non-mint parts", () => {
    expect(parseCompareInput("bonk vs wif")).toBeNull();
    expect(parseCompareInput(`bonk vs ${B}`)).toBeNull();
    expect(parseCompareInput(`${A} vs wif`)).toBeNull();
  });

  it("rejects empty and separator-only input", () => {
    expect(parseCompareInput("")).toBeNull();
    expect(parseCompareInput("vs")).toBeNull();
    expect(parseCompareInput(",")).toBeNull();
  });
});
