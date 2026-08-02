import { describe, it, expect } from "vitest";
import {
  normalize,
  skeleton,
  hasLookalikeChars,
  stripInvisibles,
  dexPairCreatedMs,
} from "@/lib/normalize";

describe("normalize", () => {
  it("replaces separators before trimming (no trailing space)", () => {
    expect(normalize("abc.")).toBe("abc");
    expect(normalize("A_B-C")).toBe("a b c");
  });
});

describe("skeleton", () => {
  it("folds Cyrillic lookalikes to Latin", () => {
    // "Воnk": Cyrillic В (U+0412) + Cyrillic о (U+043E)
    expect(skeleton("Воnk")).toBe("bonk");
    expect(skeleton("Воnk")).toBe(skeleton("Bonk"));
  });

  it("strips zero-width characters", () => {
    expect(skeleton("Bo​nk")).toBe("bonk");
    expect(skeleton("Bonk⁠")).toBe("bonk");
  });

  it("strips emoji padding", () => {
    expect(skeleton("\u{1F525}Bonk\u{1F525}")).toBe("bonk");
  });

  it("folds Greek lookalikes and fullwidth forms (NFKC)", () => {
    // Greek Β (U+0392) + omicron (U+03BF)
    expect(skeleton("Βοnk")).toBe("bonk");
    // Fullwidth "Ｂｏｎｋ"
    expect(skeleton("Ｂｏｎｋ")).toBe("bonk");
  });
});

describe("hasLookalikeChars", () => {
  it("flags Cyrillic, zero-width, and fullwidth disguises", () => {
    expect(hasLookalikeChars("Воnk")).toBe(true);
    expect(hasLookalikeChars("Bonk⁠")).toBe(true);
    expect(hasLookalikeChars("Ｂonk")).toBe(true);
  });

  it("does not flag clean names or emoji-only decoration", () => {
    expect(hasLookalikeChars("Bonk")).toBe(false);
    expect(hasLookalikeChars("\u{1F525}Bonk\u{1F525}")).toBe(false);
  });
});

describe("stripInvisibles", () => {
  it("removes zero-width/joiner/BOM characters only", () => {
    expect(stripInvisibles("Trump⁠Coin")).toBe("TrumpCoin");
    expect(stripInvisibles("﻿Bonk‍")).toBe("Bonk");
    expect(stripInvisibles("Bonk")).toBe("Bonk");
  });
});

describe("dexPairCreatedMs", () => {
  it("converts second-resolution timestamps to ms", () => {
    expect(dexPairCreatedMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("passes ms timestamps through", () => {
    expect(dexPairCreatedMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects non-finite input", () => {
    expect(dexPairCreatedMs(undefined)).toBeUndefined();
    expect(dexPairCreatedMs(Number.NaN)).toBeUndefined();
  });
});
