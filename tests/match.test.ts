import { describe, it, expect } from "vitest";
import {
  containsWholeWords,
  isCrownEligible,
  tokenMatchTier,
  tokenMatchesQuery,
} from "@/lib/match";

/**
 * Two questions, two answers — assert them separately everywhere below:
 *   tokenMatchesQuery(...)            → is it in the cohort at all?
 *   isCrownEligible(tokenMatchTier()) → may it take the OG crown?
 * The KARAT regression is a crown-eligibility fact, not a cohort fact.
 */
const eligible = (name: string | null, symbol: string | null, q: string) =>
  isCrownEligible(tokenMatchTier(name, symbol, q));

describe("tokenMatchTier — the reported KARAT bug", () => {
  it("lists a longer word that merely starts with the query, but never as a contender", () => {
    // "Karate Cat" ($KRCT) took the OG crown from a $KARAT scan because
    // "karate cat".includes("karat"). It may be SEEN (partial), never crowned.
    expect(tokenMatchTier("Karate Cat", "KRCT", "karat")).toBe("partial");
    expect(eligible("Karate Cat", "KRCT", "karat")).toBe(false);
    expect(tokenMatchTier("Karate Kid", "KARATE", "karat")).toBe("partial");
    expect(eligible("Karate Kid", "KARATE", "karat")).toBe(false);
  });

  it("still matches the token the query actually came from", () => {
    expect(tokenMatchTier("Karat Life Companion", "KARAT", "karat")).toBe("exact");
    expect(
      tokenMatchTier("Karat Life Companion", "KARAT", "karat life companion")
    ).toBe("exact");
    expect(eligible("Karat Life Companion", "KARAT", "karat")).toBe(true);
  });

  it("matches a real copycat of that name as a full contender", () => {
    expect(
      tokenMatchTier("Karat Life Companion V2", "KARAT2", "karat life companion")
    ).toBe("word");
    expect(
      tokenMatchTier("The Karat Life Companion", "KLC", "karat life companion")
    ).toBe("word");
    expect(eligible("Karat Life Companion V2", "KARAT2", "karat life companion")).toBe(
      true
    );
  });
});

describe("tokenMatchTier — word boundaries decide eligibility", () => {
  it("demotes mid-word and prefix collisions to partial", () => {
    for (const [name, symbol, q] of [
      ["Trumpet", "TRUMPET", "trump"],
      ["Bonkers", "BONKERS", "bonk"],
      ["Scatman", "SCAT", "cat"],
      ["BONKMONEY", "BONKMONEY", "bonk"],
    ] as const) {
      expect(tokenMatchTier(name, symbol, q)).toBe("partial");
      // In the cohort (this is the whole point of the tier) …
      expect(tokenMatchesQuery(name, symbol, q)).toBe(true);
      // … but never a contender for the name.
      expect(eligible(name, symbol, q)).toBe(false);
    }
    // …and a token whose ticker IS $CAT does contest a cat cohort.
    expect(tokenMatchTier("Scatman", "CAT", "cat")).toBe("exact");
    expect(eligible("Scatman", "CAT", "cat")).toBe(true);
  });

  it("accepts the query as a whole word anywhere in the name", () => {
    expect(tokenMatchTier("Bonk Coin", "BONK", "bonk")).toBe("exact"); // symbol is exact
    expect(tokenMatchTier("Chinese Bonk", "CHONK", "bonk")).toBe("word");
    expect(tokenMatchTier("Trump Coin", "TRUMPC", "trump")).toBe("word");
    expect(eligible("Chinese Bonk", "CHONK", "bonk")).toBe(true);
  });

  it("treats separators as word breaks, the way normalize() does", () => {
    expect(tokenMatchTier("karat-life", "X", "karat")).toBe("word");
    expect(tokenMatchTier("KARAT_LIFE", "X", "karat")).toBe("word");
    expect(eligible("karat-life", "X", "karat")).toBe(true);
  });

  it("returns the STRONGEST tier when several apply", () => {
    // The name would only be partial ("bonkmoney"), but the symbol is exact.
    expect(tokenMatchTier("BONKMONEY", "BONK", "bonk")).toBe("exact");
    // Whole word in the name beats a bare substring elsewhere in it.
    expect(tokenMatchTier("Bonk Bonkers", "XYZ", "bonk")).toBe("word");
    // Nothing better than a substring → partial.
    expect(tokenMatchTier("Bonkers", "XYZ", "bonk")).toBe("partial");
  });
});

describe("tokenMatchTier — tickers only reach `exact` in full", () => {
  it("keeps ticker searches working even when the name shares nothing", () => {
    // The case that would otherwise regress: searching "wif" must still find
    // dogwifhat, whose SYMBOL is exactly WIF — and it must be crownable.
    expect(tokenMatchTier("dogwifhat", "WIF", "wif")).toBe("exact");
    expect(eligible("dogwifhat", "WIF", "wif")).toBe(true);
  });

  it("never lets a ticker FRAGMENT make a contender", () => {
    // A ticker is one atomic token: "WIFHAT" contains "wif" the way any longer
    // word contains a shorter one, so it is listed and never crowned.
    expect(tokenMatchTier("Some Token", "WIFHAT", "wif")).toBe("partial");
    expect(eligible("Some Token", "WIFHAT", "wif")).toBe(false);
    expect(tokenMatchTier("Some Token", "BONKMONEY", "bonk")).toBe("partial");
    expect(eligible("Some Token", "BONKMONEY", "bonk")).toBe(false);
  });

  it("returns null when nothing relates at all", () => {
    expect(tokenMatchTier("Some Token", "KRCT", "karat")).toBe(null);
    expect(tokenMatchesQuery("Some Token", "KRCT", "karat")).toBe(false);
    expect(eligible("Some Token", "KRCT", "karat")).toBe(false);
  });
});

describe("tokenMatchTier — lookalikes still admitted", () => {
  it("matches a Cyrillic copycat of a clean query, at full strength", () => {
    // "Воnk" with Cyrillic В and о — must still enter the cohort so it can be
    // ranked AND flagged, rather than silently disappearing.
    expect(tokenMatchTier("Воnk", "BONK", "bonk")).toBe("exact");
    expect(eligible("Воnk", "BONK", "bonk")).toBe(true);
    // Folding alone, with no ticker to lean on, still reaches `word`.
    expect(tokenMatchTier("Воnk Coin", "XYZ", "bonk")).toBe("word");
  });

  it("matches a clean token from a lookalike query", () => {
    expect(tokenMatchTier("Bonk", "BONK", "Воnk")).toBe("exact");
  });

  it("does not let folding reintroduce mid-word CONTENDERS", () => {
    // Folds to "karate cat", which contains "karat" — so it is listed as a
    // related name, exactly like its unfolded twin, and stays uncrownable.
    expect(tokenMatchTier("Kаrate Cat", "KRCT", "karat")).toBe("partial");
    expect(eligible("Kаrate Cat", "KRCT", "karat")).toBe(false);
  });
});

describe("isCrownEligible", () => {
  it("admits exact and word, refuses partial and null", () => {
    expect(isCrownEligible("exact")).toBe(true);
    expect(isCrownEligible("word")).toBe(true);
    expect(isCrownEligible("partial")).toBe(false);
    expect(isCrownEligible(null)).toBe(false);
  });
});

describe("edge cases", () => {
  it("handles empty/absent fields without throwing", () => {
    expect(tokenMatchTier(null, null, "bonk")).toBe(null);
    expect(tokenMatchesQuery(null, null, "bonk")).toBe(false);
    expect(tokenMatchTier("Bonk", "BONK", "")).toBe(null);
    expect(tokenMatchesQuery("Bonk", "BONK", "")).toBe(false);
    expect(tokenMatchesQuery("", "", "")).toBe(false);
    expect(tokenMatchTier(undefined, "BONK", "bonk")).toBe("exact");
    expect(tokenMatchesQuery(undefined, "BONK", "bonk")).toBe(true);
  });

  it("an empty name/symbol never matches an empty-ish query by accident", () => {
    expect(tokenMatchTier("", "", "bonk")).toBe(null);
    expect(tokenMatchTier("Bonk", "", "bonk")).toBe("exact");
  });

  it("containsWholeWords is exported and behaves", () => {
    expect(containsWholeWords("karat life companion", "karat")).toBe(true);
    expect(containsWholeWords("karate cat", "karat")).toBe(false);
    expect(containsWholeWords("", "karat")).toBe(false);
    expect(containsWholeWords("karat", "")).toBe(false);
  });
});
