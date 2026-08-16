import { describe, it, expect } from "vitest";
import { tokenMatchesQuery, containsWholeWords } from "@/lib/match";

describe("tokenMatchesQuery — the reported KARAT bug", () => {
  it("does NOT match a longer word that merely starts with the query", () => {
    // "Karate Cat" ($KRCT) took the OG crown from a $KARAT scan because
    // "karate cat".includes("karat"). It must not be in the cohort at all.
    expect(tokenMatchesQuery("Karate Cat", "KRCT", "karat")).toBe(false);
    expect(tokenMatchesQuery("Karate Kid", "KARATE", "karat")).toBe(false);
  });

  it("still matches the token the query actually came from", () => {
    expect(tokenMatchesQuery("Karat Life Companion", "KARAT", "karat")).toBe(true);
    expect(
      tokenMatchesQuery("Karat Life Companion", "KARAT", "karat life companion")
    ).toBe(true);
  });

  it("matches a real copycat of that name", () => {
    expect(tokenMatchesQuery("Karat Life Companion V2", "KARAT2", "karat life companion")).toBe(true);
    expect(tokenMatchesQuery("The Karat Life Companion", "KLC", "karat life companion")).toBe(true);
  });
});

describe("tokenMatchesQuery — word boundaries", () => {
  it("rejects mid-word and prefix collisions", () => {
    expect(tokenMatchesQuery("Trumpet", "TRUMPET", "trump")).toBe(false);
    expect(tokenMatchesQuery("Bonkers", "BONKERS", "bonk")).toBe(false);
    expect(tokenMatchesQuery("Scatman", "SCAT", "cat")).toBe(false);
    // …but a token whose ticker IS $CAT does belong in a cat cohort.
    expect(tokenMatchesQuery("Scatman", "CAT", "cat")).toBe(true);
  });

  it("accepts the query as a whole word anywhere in the name", () => {
    expect(tokenMatchesQuery("Bonk Coin", "BONK", "bonk")).toBe(true);
    expect(tokenMatchesQuery("Chinese Bonk", "CHONK", "bonk")).toBe(true);
    expect(tokenMatchesQuery("Trump Coin", "TRUMPC", "trump")).toBe(true);
  });

  it("treats separators as word breaks, the way normalize() does", () => {
    expect(tokenMatchesQuery("karat-life", "X", "karat")).toBe(true);
    expect(tokenMatchesQuery("KARAT_LIFE", "X", "karat")).toBe(true);
  });
});

describe("tokenMatchesQuery — tickers match in full", () => {
  it("keeps ticker searches working even when the name shares nothing", () => {
    // The case that would otherwise regress: searching "wif" must still find
    // dogwifhat, whose SYMBOL is exactly WIF.
    expect(tokenMatchesQuery("dogwifhat", "WIF", "wif")).toBe(true);
  });

  it("never matches a ticker on a fragment", () => {
    expect(tokenMatchesQuery("Some Token", "KRCT", "karat")).toBe(false);
    expect(tokenMatchesQuery("Some Token", "WIFHAT", "wif")).toBe(false);
    expect(tokenMatchesQuery("Some Token", "BONKMONEY", "bonk")).toBe(false);
  });
});

describe("tokenMatchesQuery — lookalikes still admitted", () => {
  it("matches a Cyrillic copycat of a clean query", () => {
    // "Воnk" with Cyrillic В and о — must still enter the cohort so it can be
    // ranked AND flagged, rather than silently disappearing.
    expect(tokenMatchesQuery("Воnk", "BONK", "bonk")).toBe(true);
  });

  it("matches a clean token from a lookalike query", () => {
    expect(tokenMatchesQuery("Bonk", "BONK", "Воnk")).toBe(true);
  });

  it("does not let folding reintroduce mid-word matches", () => {
    expect(tokenMatchesQuery("Kаrate Cat", "KRCT", "karat")).toBe(false);
  });
});

describe("edge cases", () => {
  it("handles empty/absent fields without throwing", () => {
    expect(tokenMatchesQuery(null, null, "bonk")).toBe(false);
    expect(tokenMatchesQuery("Bonk", "BONK", "")).toBe(false);
    expect(tokenMatchesQuery("", "", "")).toBe(false);
    expect(tokenMatchesQuery(undefined, "BONK", "bonk")).toBe(true);
  });

  it("containsWholeWords is exported and behaves", () => {
    expect(containsWholeWords("karat life companion", "karat")).toBe(true);
    expect(containsWholeWords("karate cat", "karat")).toBe(false);
    expect(containsWholeWords("", "karat")).toBe(false);
    expect(containsWholeWords("karat", "")).toBe(false);
  });
});
