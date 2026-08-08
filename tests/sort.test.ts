import { describe, it, expect } from "vitest";
import {
  ageDataQuality,
  ageOrderConfidence,
  isOgEndorsement,
  scoreConfidence,
  sortByCreationTime,
  UNPROVEN_RANK1_LABEL,
  UNSAFE_RANK1_LABEL,
} from "@/lib/sort";
import type { TokenResult } from "@/lib/types";

/** Minimal TokenResult factory — only the fields the scorers read. */
function make(partial: Partial<TokenResult>): TokenResult {
  return {
    mint: "Mint11111111111111111111111111111111111111",
    displayName: "Token",
    displaySymbol: "TKN",
    slot: null,
    createdAtMs: null,
    createdAt: null,
    dexId: null,
    confidence: 0,
    confidenceLabel: "",
    rank: 0,
    rankLabel: "",
    timeSource: null,
    volumeUsd24h: null,
    marketCapUsd: null,
    fdvUsd: null,
    ...partial,
  } as TokenResult;
}

const YEAR = 365 * 24 * 3600 * 1000;
const MONTH = 30 * 24 * 3600 * 1000;

describe("ageDataQuality", () => {
  it("tiers by time source", () => {
    expect(ageDataQuality(make({ createdAtMs: 1, timeSource: "helius" }))).toBe(5);
    expect(
      ageDataQuality(make({ createdAtMs: 1, timeSource: "signatures" }))
    ).toBe(4);
    expect(
      ageDataQuality(make({ createdAtMs: 1, timeSource: "dexscreener" }))
    ).toBe(3);
  });

  it("caps at 3 for lower-bound creation times", () => {
    expect(
      ageDataQuality(
        make({
          createdAtMs: 1,
          timeSource: "signatures",
          createdAtIsLowerBound: true,
        })
      )
    ).toBe(3);
  });

  it("returns 1 for pending or missing age", () => {
    expect(ageDataQuality(make({ pendingAge: true, createdAtMs: 1 }))).toBe(1);
    expect(ageDataQuality(make({ createdAtMs: null }))).toBe(1);
  });
});

describe("ageOrderConfidence", () => {
  const exact = (mint: string, iso: string, over?: Partial<TokenResult>) =>
    make({
      mint,
      createdAtMs: Date.parse(iso),
      createdAt: iso,
      timeSource: "signatures",
      ...over,
    });

  it("is proven when every ranked age is exact", () => {
    const order = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z"),
      exact("B", "2023-01-01T00:00:00Z"),
      exact("C", "2024-01-01T00:00:00Z"),
    ]);
    expect(order).toEqual({
      proven: true,
      blockingMints: [],
      blockingCount: 0,
      unresolvedMints: [],
      unresolvedCount: 0,
    });
  });

  it("is unproven when a lower bound below #1 sits within the material window", () => {
    const order = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z"),
      exact("B", "2022-04-01T00:00:00Z", { createdAtIsLowerBound: true }),
    ]);
    // B's true creation is AT OR BEFORE 2022-04 by an unknown amount, and three
    // months of quiet before heavy trading is ordinary — it could predate A.
    // This is the shape of the reported regression.
    expect(order.proven).toBe(false);
    expect(order.blockingMints).toEqual(["B"]);
    expect(order.unresolvedMints).toEqual(["B"]);
    expect(order.unresolvedCount).toBe(1);
  });

  it("still counts — but is not blocked by — a bound years newer than the leader", () => {
    // Real shape of the "bonk" cohort: every unresolved bound is 29-44 months
    // newer than BONK, which would require years of dormancy to overturn it.
    const order = ageOrderConfidence([
      exact("A", "2022-12-20T00:00:00Z"),
      exact("B", "2025-05-13T00:00:00Z", { createdAtIsLowerBound: true }),
      exact("C", "2026-08-07T00:00:00Z", { createdAtIsLowerBound: true }),
    ]);
    expect(order.proven).toBe(true);
    expect(order.blockingMints).toEqual([]);
    // Never hidden: the caveat still reports them.
    expect(order.unresolvedMints).toEqual(["B", "C"]);
    expect(order.unresolvedCount).toBe(2);
  });

  it("MATERIALITY BOUNDARY: exactly at the window blocks, just past it does not", () => {
    const leaderMs = Date.parse("2022-01-01T00:00:00Z");
    const at = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z"),
      make({
        mint: "B",
        createdAtMs: leaderMs + YEAR,
        createdAtIsLowerBound: true,
      }),
    ]);
    expect(at.proven).toBe(false);

    const past = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z"),
      make({
        mint: "B",
        createdAtMs: leaderMs + YEAR + 1,
        createdAtIsLowerBound: true,
      }),
    ]);
    expect(past.proven).toBe(true);
    expect(past.unresolvedCount).toBe(1);
  });

  it("is unproven when the leader itself is a lower bound (leader listed first)", () => {
    const order = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z", { createdAtIsLowerBound: true }),
      exact("B", "2023-01-01T00:00:00Z", { createdAtIsLowerBound: true }),
    ]);
    expect(order.proven).toBe(false);
    expect(order.unresolvedMints).toEqual(["A", "B"]);
  });

  it("is unproven when the leader is still pending or undated", () => {
    expect(
      ageOrderConfidence([make({ mint: "A", pendingAge: true, createdAtMs: 1 })])
        .proven
    ).toBe(false);
    expect(
      ageOrderConfidence([make({ mint: "A", createdAtMs: null })]).proven
    ).toBe(false);
  });

  it("ignores a follower's MISSING date — only lower bounds contest the lead", () => {
    // An undated follower is "unknown", not "could be older": the pipeline
    // sends it to the bottom and the leader's own check owns the only claim.
    const order = ageOrderConfidence([
      exact("A", "2022-01-01T00:00:00Z"),
      make({ mint: "B", createdAtMs: null }),
    ]);
    expect(order.proven).toBe(true);
  });

  it("empty and single-token lists", () => {
    expect(ageOrderConfidence([])).toEqual({
      proven: true,
      blockingMints: [],
      blockingCount: 0,
      unresolvedMints: [],
      unresolvedCount: 0,
    });
    // One exact token is trivially the oldest of one.
    expect(ageOrderConfidence([exact("A", "2022-01-01T00:00:00Z")]).proven).toBe(
      true
    );
  });

  it("INVARIANT: a bound OLDER than the leader cannot stay below it post-sort", () => {
    // A truncated token whose bound predates the leader IS older (true ≤ bound
    // < leader), and sortByCreationTime puts it first — so ageOrderConfidence
    // never has to reason about that case.
    const leader = exact("Leader", "2023-01-01T00:00:00Z");
    const olderBound = exact("Bound", "2022-01-01T00:00:00Z", {
      createdAtIsLowerBound: true,
    });
    const sorted = sortByCreationTime([leader, olderBound]);
    expect(sorted.map((t) => t.mint)).toEqual(["Bound", "Leader"]);
    // It is now the leader, and its own bound is what makes the order unproven.
    expect(ageOrderConfidence(sorted).unresolvedMints).toEqual(["Bound"]);
  });
});

describe("scoreConfidence", () => {
  const og = make({
    mint: "OGmint111111111111111111111111111111111111",
    displayName: "Bonk",
    displaySymbol: "Bonk",
    createdAtMs: Date.parse("2022-12-20T00:00:00Z"),
    timeSource: "signatures",
  });
  const copycat = make({
    mint: "Copy1111111111111111111111111111111111111",
    displayName: "Bonk",
    displaySymbol: "Bonk",
    createdAtMs: Date.parse("2022-12-20T00:00:00Z") + 3 * YEAR,
    timeSource: "dexscreener",
  });

  it("awards the strong OG label only to rank 1 with exact match, gap, and stars>=4", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("OG");
    expect(scored[0].rank).toBe(1);
  });

  it("never puts OG-flavored labels on ranks 2+", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[1].confidenceLabel).toBe("");
    expect(scored[1].rank).toBe(2);
  });

  it("downgrades rank 1 to Likely OG when age data is pair-time only", () => {
    const weakOg = make({
      ...og,
      timeSource: "dexscreener",
    });
    const scored = scoreConfidence([weakOg, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Likely OG");
  });

  it("demotes a homoglyph-suspect rank 1 to Oldest found", () => {
    const fake = make({ ...og, homoglyphSuspect: true });
    const scored = scoreConfidence([fake, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Oldest found");
  });

  it("labels lower-bound rank 1 as Oldest found", () => {
    const uncertain = make({ ...og, createdAtIsLowerBound: true });
    const scored = scoreConfidence([uncertain, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe("Oldest found");
  });

  it("strips the OG endorsement from a rank-1 with a blocking safety flag", () => {
    const honeypot = make({
      ...og,
      safetyLevel: "danger",
      safetyFlags: ["freeze-authority"],
    });
    const scored = scoreConfidence([honeypot, copycat], "bonk");
    // Rank stays factual — it IS the oldest.
    expect(scored[0].rank).toBe(1);
    expect(scored[0].mint).toBe(og.mint);
    // The endorsement does not.
    expect(scored[0].confidenceLabel).toBe(UNSAFE_RANK1_LABEL);
    expect(scored[0].confidenceLabel).toBe("Oldest — unsafe");
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
    expect(scored[0].rankLabel).toBe(UNSAFE_RANK1_LABEL);
  });

  it("keeps the crown for caution, clear, and unknown levels", () => {
    for (const level of ["caution", "clear", "unknown"] as const) {
      const scored = scoreConfidence(
        [make({ ...og, safetyLevel: level }), copycat],
        "bonk"
      );
      expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(true);
    }
  });

  it("an unassessed rank 1 still earns the crown (absent ≠ dangerous)", () => {
    const scored = scoreConfidence([og, copycat], "bonk");
    expect(scored[0].safetyLevel).toBeUndefined();
    expect(scored[0].confidenceLabel).toBe("OG");
  });

  it("uncertain age keeps precedence over the unsafe label", () => {
    // Either way it is not an endorsement; the age caveat is the more
    // fundamental one, so it wins the single label slot.
    const scored = scoreConfidence(
      [make({ ...og, createdAtIsLowerBound: true, safetyLevel: "danger" }), copycat],
      "bonk"
    );
    expect(scored[0].confidenceLabel).toBe("Oldest found");
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
  });

  it("leaves ranks 2+ unlabeled even when they are dangerous", () => {
    const scored = scoreConfidence(
      [og, make({ ...copycat, safetyLevel: "danger" })],
      "bonk"
    );
    expect(scored[1].confidenceLabel).toBe("");
    expect(scored[1].safetyLevel).toBe("danger");
  });

  it("carries safetyLevel and flags through a client-side re-score", () => {
    const scored = scoreConfidence(
      [
        make({
          ...og,
          safetyLevel: "danger",
          safetyFlags: ["transfer-hook", "mint-authority"],
        }),
        copycat,
      ],
      "bonk"
    );
    expect(scored[0].safetyFlags).toEqual(["transfer-hook", "mint-authority"]);
    // Re-scoring the output (what Results.tsx does) must be stable.
    const again = scoreConfidence(scored, "bonk");
    expect(again[0].confidenceLabel).toBe(UNSAFE_RANK1_LABEL);
  });

  /**
   * A truncated bound close enough to the leader to be a credible threat —
   * `copycat` sits 3 years out, which the materiality window treats as noise.
   */
  const nearTruncated = make({
    mint: "Near1111111111111111111111111111111111111",
    displayName: "Bonk",
    displaySymbol: "Bonk",
    createdAtMs: Date.parse("2022-12-20T00:00:00Z") + 3 * MONTH,
    timeSource: "signatures",
    createdAtIsLowerBound: true,
  });

  it("keeps the crown when the only lower bound is years newer than the leader", () => {
    const distant = make({ ...copycat, createdAtIsLowerBound: true });
    const scored = scoreConfidence([og, distant], "bonk");
    expect(scored[0].confidenceLabel).toBe("OG");
    expect(scored[0].ageOrderUnproven).toBeUndefined();
  });

  it("withholds the crown when a token ranked below is still a lower bound", () => {
    const truncated = make({
      ...nearTruncated,
      timeSource: "signatures",
    });
    const scored = scoreConfidence([og, truncated], "bonk");
    // Rank is unchanged — the order we have is still our best answer.
    expect(scored[0].mint).toBe(og.mint);
    expect(scored[0].rank).toBe(1);
    // The endorsement is not.
    expect(scored[0].confidenceLabel).toBe(UNPROVEN_RANK1_LABEL);
    expect(scored[0].confidenceLabel).toBe("Oldest known — unverified");
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
    expect(scored[0].rankLabel).toBe(UNPROVEN_RANK1_LABEL);
    expect(scored[0].ageOrderUnproven).toBe(true);
    // Only rank 1 carries the flag.
    expect(scored[1].ageOrderUnproven).toBeUndefined();
  });

  it("PRECEDENCE: own-age uncertainty > danger > order-unproven > OG", () => {
    const truncatedFollower = nearTruncated;
    // 1. Rank 1's own age uncertain — wins over everything below it.
    expect(
      scoreConfidence(
        [
          make({ ...og, createdAtIsLowerBound: true, safetyLevel: "danger" }),
          truncatedFollower,
        ],
        "bonk"
      )[0].confidenceLabel
    ).toBe("Oldest found");
    // 2. Own age exact + blocking flag + unproven order → the safety wording.
    expect(
      scoreConfidence(
        [make({ ...og, safetyLevel: "danger" }), truncatedFollower],
        "bonk"
      )[0].confidenceLabel
    ).toBe(UNSAFE_RANK1_LABEL);
    // 3. Own age exact, safe, order unproven → the order wording.
    expect(
      scoreConfidence([og, truncatedFollower], "bonk")[0].confidenceLabel
    ).toBe(UNPROVEN_RANK1_LABEL);
    // 4. Nothing outstanding → the endorsement.
    expect(scoreConfidence([og, copycat], "bonk")[0].confidenceLabel).toBe("OG");
  });

  it("keeps the unproven flag through a client-side re-score", () => {
    const scored = scoreConfidence([og, nearTruncated], "bonk");
    const again = scoreConfidence(scored, "bonk");
    expect(again[0].confidenceLabel).toBe(UNPROVEN_RANK1_LABEL);
    expect(again[0].ageOrderUnproven).toBe(true);
  });

  it("a flag on the wire survives a re-score of a SLICED list", () => {
    // The server scores the full cohort, then slices to MAX_RESULTS: the
    // client can re-score a list the truncated token never made it into.
    const stamped = { ...og, ageOrderUnproven: true as const };
    const scored = scoreConfidence([stamped, copycat], "bonk");
    expect(scored[0].confidenceLabel).toBe(UNPROVEN_RANK1_LABEL);
  });

  it("drops a stale flag from a token that is no longer rank 1", () => {
    const demoted = make({
      ...copycat,
      ageOrderUnproven: true,
      createdAtMs: Date.parse("2022-12-20T00:00:00Z") + 3 * YEAR,
    });
    const scored = scoreConfidence([og, demoted], "bonk");
    expect(scored[1].ageOrderUnproven).toBeUndefined();
    // ...but the leader inherits nothing from it either: the list is clean.
    expect(scored[0].confidenceLabel).toBe("OG");
  });

  it("REPORTED CASE: an exact-dated 2025 leader with a truncated 2025 follower earns no OG", () => {
    // Production shape of the regression's cohort AFTER the deep walk is still
    // short: A is exactly dated, B's walk hit the page budget, so B's shown
    // date is only an upper limit — B really was minted 2024-02-17.
    const a = make({
      mint: "Q32DNrAFDCXJQy7q8CNrmJyV2BVvgeWbPhbwVcypump",
      displayName: "Pepe Cosplay",
      displaySymbol: "COPEPE",
      createdAtMs: Date.parse("2025-05-25T17:26:35Z"),
      createdAt: "2025-05-25T17:26:35.000Z",
      timeSource: "signatures",
    });
    const b = make({
      mint: "Erb3CTbFpQKAgaWRBksBD3uNBdhNQ33X1eA5sue7bAiz",
      displayName: "COPEPE",
      displaySymbol: "COPEPE",
      createdAtMs: Date.parse("2025-08-29T08:07:57Z"),
      createdAt: "2025-08-29T08:07:57.000Z",
      timeSource: "signatures",
      createdAtIsLowerBound: true,
    });
    const scored = scoreConfidence(sortByCreationTime([a, b]), "copepe");
    expect(scored.map((t) => t.mint)).toEqual([a.mint, b.mint]);
    expect(isOgEndorsement(scored[0].confidenceLabel)).toBe(false);
    expect(scored[0].confidenceLabel).toBe(UNPROVEN_RANK1_LABEL);
    expect(scored[0].ageOrderUnproven).toBe(true);

    // Once B's walk completes, B is the older token, it takes rank 1, and the
    // cohort is fully dated — the crown becomes earnable again.
    const bResolved = make({
      ...b,
      createdAtMs: 1708178206 * 1000,
      createdAt: new Date(1708178206 * 1000).toISOString(),
      createdAtIsLowerBound: undefined,
    });
    const after = scoreConfidence(sortByCreationTime([a, bResolved]), "copepe");
    expect(after[0].mint).toBe(b.mint);
    expect(after[0].createdAt).toBe("2024-02-17T13:56:46.000Z");
    expect(after[0].ageOrderUnproven).toBeUndefined();
    expect(isOgEndorsement(after[0].confidenceLabel)).toBe(true);
  });

  it("sets exactMatch only when name AND symbol both match", () => {
    const nameOnly = make({
      ...copycat,
      displayName: "bonk",
      displaySymbol: "OTHER",
    });
    const scored = scoreConfidence([og, nameOnly], "bonk");
    expect(scored[0].exactMatch).toBe(true);
    expect(scored[1].exactMatch).toBeUndefined();
  });
});
