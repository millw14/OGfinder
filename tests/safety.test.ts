import { describe, it, expect } from "vitest";
import {
  assessSafety,
  flagFromCode,
  isBlockingCode,
  CONCENTRATION_PCT,
  EXTREME_FEE_BPS,
  FEW_SELLS_MIN_BUYS,
  FEW_SELLS_RATIO,
  HIGH_FEE_BPS,
  MIN_LIQUIDITY_USD,
  NO_SELLS_MIN_BUYS,
  type MintExtensionFacts,
  type SafetyFlagCode,
  type SafetyInput,
} from "@/lib/safety";
import { FRESH_WALLET_MS, SERIAL_DEPLOYER_MIN } from "@/lib/types";

/** No Token-2022 machinery — a completed check with nothing to report. */
const cleanExt: MintExtensionFacts = {
  hasTransferHook: false,
  nonTransferable: false,
  defaultAccountFrozen: false,
  permanentDelegate: null,
  transferFeeBps: null,
  isToken2022: false,
};

/**
 * A token where every blocking check RAN and came back negative — the only
 * state that may be called "clear". Individual tests break one thing at a time.
 */
function checkedClean(over: Partial<SafetyInput> = {}): SafetyInput {
  return {
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    extensions: cleanExt,
    buys24h: 120,
    sells24h: 90,
    ...over,
  };
}

function codes(input: SafetyInput, now?: number): SafetyFlagCode[] {
  return assessSafety(input, now).flags.map((f) => f.code);
}

const NOW = Date.parse("2026-08-05T00:00:00.000Z");

describe("thresholds are the documented values", () => {
  it("pins every constant", () => {
    expect(NO_SELLS_MIN_BUYS).toBe(10);
    expect(FEW_SELLS_MIN_BUYS).toBe(50);
    expect(FEW_SELLS_RATIO).toBe(0.03);
    expect(EXTREME_FEE_BPS).toBe(5000);
    expect(HIGH_FEE_BPS).toBe(1000);
    expect(CONCENTRATION_PCT).toBe(90);
    expect(MIN_LIQUIDITY_USD).toBe(1000);
  });
});

describe("blocking flags — honeypot tier", () => {
  const ext = (over: Partial<MintExtensionFacts>): MintExtensionFacts => ({
    ...cleanExt,
    isToken2022: true,
    ...over,
  });

  const cases: [string, SafetyInput, SafetyFlagCode][] = [
    [
      "transfer hook",
      checkedClean({ extensions: ext({ hasTransferHook: true }) }),
      "transfer-hook",
    ],
    [
      "non-transferable",
      checkedClean({ extensions: ext({ nonTransferable: true }) }),
      "non-transferable",
    ],
    [
      "default account state frozen",
      checkedClean({ extensions: ext({ defaultAccountFrozen: true }) }),
      "default-frozen",
    ],
    [
      "extreme transfer fee",
      checkedClean({ extensions: ext({ transferFeeBps: EXTREME_FEE_BPS }) }),
      "transfer-fee-extreme",
    ],
    [
      "buys with zero sells",
      checkedClean({ buys24h: NO_SELLS_MIN_BUYS, sells24h: 0 }),
      "no-sells",
    ],
  ];

  for (const [label, input, code] of cases) {
    it(`${label} → danger`, () => {
      const out = assessSafety(input, NOW);
      expect(out.level).toBe("danger");
      expect(out.flags.map((f) => f.code)).toContain(code);
      expect(isBlockingCode(code)).toBe(true);
    });
  }

  it("an inert transfer hook (no program installed) is not a flag", () => {
    // hasTransferHook is only true when programId is non-null — PYUSD and PUMP
    // both carry the extension with programId null.
    const out = assessSafety(
      checkedClean({ extensions: ext({ hasTransferHook: false }) }),
      NOW
    );
    expect(out.level).toBe("clear");
  });
});

describe("blocking flags — seizable tier", () => {
  it("freeze authority costs the endorsement but is named as a mechanism", () => {
    const out = assessSafety(
      checkedClean({ freezeAuthorityActive: true }),
      NOW
    );
    expect(out.level).toBe("danger");
    const flag = out.flags.find((f) => f.code === "freeze-authority")!;
    expect(flag.tier).toBe("blocking");
    expect(flag.detail).toMatch(/freeze holder accounts/i);
    // Never a generic accusation.
    expect(flag.detail).not.toMatch(/scam|rug|fraud/i);
  });

  it("permanent delegate → danger", () => {
    const out = assessSafety(
      checkedClean({
        extensions: {
          ...cleanExt,
          isToken2022: true,
          permanentDelegate: "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk",
        },
      }),
      NOW
    );
    expect(out.level).toBe("danger");
    expect(out.flags.map((f) => f.code)).toContain("permanent-delegate");
  });
});

describe("no-sells threshold — dead tokens are not honeypots", () => {
  it("0 buys and 0 sells is DEAD, never flagged", () => {
    const out = assessSafety(checkedClean({ buys24h: 0, sells24h: 0 }), NOW);
    expect(out.flags.map((f) => f.code)).not.toContain("no-sells");
    expect(out.flags.map((f) => f.code)).not.toContain("few-sells");
    expect(out.level).toBe("clear");
  });

  it("does not fire one buy below the floor", () => {
    expect(
      codes(checkedClean({ buys24h: NO_SELLS_MIN_BUYS - 1, sells24h: 0 }), NOW)
    ).not.toContain("no-sells");
  });

  it("fires exactly at the floor", () => {
    expect(
      codes(checkedClean({ buys24h: NO_SELLS_MIN_BUYS, sells24h: 0 }), NOW)
    ).toContain("no-sells");
  });

  it("a single successful sell clears it", () => {
    expect(
      codes(checkedClean({ buys24h: 5000, sells24h: 1 }), NOW)
    ).not.toContain("no-sells");
  });

  it("never fires when the counts were not reported", () => {
    const out = assessSafety(
      checkedClean({ buys24h: undefined, sells24h: undefined }),
      NOW
    );
    expect(out.flags).toHaveLength(0);
    expect(out.checked.trades).toBe(false);
  });
});

describe("few-sells caution", () => {
  it("fires under the ratio with a big enough sample", () => {
    // 1/50 = 0.02 < 0.03
    const out = assessSafety(
      checkedClean({ buys24h: FEW_SELLS_MIN_BUYS, sells24h: 1 }),
      NOW
    );
    expect(out.level).toBe("caution");
    expect(out.flags.map((f) => f.code)).toContain("few-sells");
  });

  it("does not fire at or above the ratio", () => {
    // 2/50 = 0.04 > 0.03
    expect(
      codes(checkedClean({ buys24h: 50, sells24h: 2 }), NOW)
    ).not.toContain("few-sells");
  });

  it("does not fire below the sample floor", () => {
    expect(
      codes(
        checkedClean({ buys24h: FEW_SELLS_MIN_BUYS - 1, sells24h: 1 }),
        NOW
      )
    ).not.toContain("few-sells");
  });

  it("is not doubled up with no-sells", () => {
    const out = codes(checkedClean({ buys24h: 200, sells24h: 0 }), NOW);
    expect(out).toContain("no-sells");
    expect(out).not.toContain("few-sells");
  });
});

describe("transfer fee tiers", () => {
  const withFee = (bps: number) =>
    checkedClean({
      extensions: { ...cleanExt, isToken2022: true, transferFeeBps: bps },
    });

  it("under 10% is not flagged", () => {
    expect(codes(withFee(HIGH_FEE_BPS - 1), NOW)).toHaveLength(0);
  });

  it("10% is a caution", () => {
    const out = assessSafety(withFee(HIGH_FEE_BPS), NOW);
    expect(out.level).toBe("caution");
    expect(out.flags.map((f) => f.code)).toEqual(["transfer-fee-high"]);
  });

  it("just under 50% stays a caution", () => {
    expect(assessSafety(withFee(EXTREME_FEE_BPS - 1), NOW).level).toBe(
      "caution"
    );
  });

  it("50% is blocking, and never doubles as the high-fee caution", () => {
    const out = assessSafety(withFee(EXTREME_FEE_BPS), NOW);
    expect(out.level).toBe("danger");
    expect(out.flags.map((f) => f.code)).toEqual(["transfer-fee-extreme"]);
  });

  it("a zero-bps fee config is not a finding", () => {
    // PYUSD ships transferFeeConfig with transferFeeBasisPoints 0.
    expect(assessSafety(withFee(0), NOW).level).toBe("clear");
  });
});

describe("caution flags and their boundaries", () => {
  it("mint authority", () => {
    const out = assessSafety(checkedClean({ mintAuthorityActive: true }), NOW);
    expect(out.level).toBe("caution");
    expect(out.flags.map((f) => f.code)).toEqual(["mint-authority"]);
  });

  it("holder concentration boundary", () => {
    expect(
      codes(checkedClean({ topHolderPct: CONCENTRATION_PCT - 0.1 }), NOW)
    ).not.toContain("holders-concentrated");
    expect(
      codes(checkedClean({ topHolderPct: CONCENTRATION_PCT }), NOW)
    ).toContain("holders-concentrated");
  });

  it("liquidity boundary", () => {
    expect(
      codes(checkedClean({ liquidityUsd: MIN_LIQUIDITY_USD }), NOW)
    ).not.toContain("low-liquidity");
    expect(
      codes(checkedClean({ liquidityUsd: MIN_LIQUIDITY_USD - 0.01 }), NOW)
    ).toContain("low-liquidity");
    // Absent liquidity is unknown, not zero.
    expect(
      codes(checkedClean({ liquidityUsd: null }), NOW)
    ).not.toContain("low-liquidity");
  });

  it("serial deployer boundary", () => {
    expect(
      codes(checkedClean({ deployerTokensCreated: SERIAL_DEPLOYER_MIN - 1 }), NOW)
    ).not.toContain("serial-deployer");
    expect(
      codes(checkedClean({ deployerTokensCreated: SERIAL_DEPLOYER_MIN }), NOW)
    ).toContain("serial-deployer");
    expect(
      codes(checkedClean({ deployerTokensCreated: null }), NOW)
    ).not.toContain("serial-deployer");
  });

  it("fresh deployer wallet boundary", () => {
    expect(
      codes(
        checkedClean({ deployerWalletFirstSeenMs: NOW - FRESH_WALLET_MS + 1 }),
        NOW
      )
    ).toContain("fresh-deployer");
    expect(
      codes(
        checkedClean({ deployerWalletFirstSeenMs: NOW - FRESH_WALLET_MS }),
        NOW
      )
    ).not.toContain("fresh-deployer");
  });

  it("mutable metadata, lookalike name, and zero supply", () => {
    expect(codes(checkedClean({ metadataMutable: true }), NOW)).toEqual([
      "mutable-metadata",
    ]);
    expect(codes(checkedClean({ homoglyphSuspect: true }), NOW)).toEqual([
      "lookalike-name",
    ]);
    expect(codes(checkedClean({ supplyZero: true }), NOW)).toEqual([
      "supply-zero",
    ]);
  });
});

describe("levels: unknown is never safe, clear is never a guarantee", () => {
  it("clear only when every blocking check ran and found nothing", () => {
    const out = assessSafety(checkedClean(), NOW);
    expect(out.level).toBe("clear");
    expect(out.checked).toEqual({
      authorities: true,
      extensions: true,
      trades: true,
    });
  });

  it("missing extension read → unknown, not clear", () => {
    const out = assessSafety(checkedClean({ extensions: null }), NOW);
    expect(out.level).toBe("unknown");
    expect(out.checked.extensions).toBe(false);
  });

  it("missing trade counts → unknown, not clear", () => {
    const out = assessSafety(
      checkedClean({ buys24h: null, sells24h: null }),
      NOW
    );
    expect(out.level).toBe("unknown");
    expect(out.checked.trades).toBe(false);
  });

  it("missing authorities → unknown, not clear", () => {
    const out = assessSafety(
      checkedClean({
        mintAuthorityActive: undefined,
        freezeAuthorityActive: undefined,
      }),
      NOW
    );
    expect(out.level).toBe("unknown");
    expect(out.checked.authorities).toBe(false);
  });

  it("an empty token (nothing known at all) is unknown", () => {
    const out = assessSafety({}, NOW);
    expect(out.level).toBe("unknown");
    expect(out.flags).toHaveLength(0);
  });

  it("a plain SPL mint counts as a completed extension check", () => {
    expect(assessSafety(checkedClean(), NOW).checked.extensions).toBe(true);
  });

  it("caution findings still report caution when other checks are missing", () => {
    const out = assessSafety(
      { mintAuthorityActive: true, extensions: null },
      NOW
    );
    expect(out.level).toBe("caution");
  });

  it("danger outranks every caution finding", () => {
    const out = assessSafety(
      checkedClean({
        freezeAuthorityActive: true,
        mintAuthorityActive: true,
        metadataMutable: true,
        topHolderPct: 99,
      }),
      NOW
    );
    expect(out.level).toBe("danger");
    // Blocking findings come first so the UI headline is the worst one.
    expect(out.flags[0].tier).toBe("blocking");
  });
});

describe("flagFromCode", () => {
  const all: SafetyFlagCode[] = [
    "transfer-hook",
    "non-transferable",
    "default-frozen",
    "transfer-fee-extreme",
    "no-sells",
    "freeze-authority",
    "permanent-delegate",
    "mint-authority",
    "transfer-fee-high",
    "holders-concentrated",
    "low-liquidity",
    "mutable-metadata",
    "lookalike-name",
    "serial-deployer",
    "fresh-deployer",
    "supply-zero",
    "few-sells",
  ];

  it("re-derives a specific, mechanism-first flag for every code", () => {
    for (const code of all) {
      const flag = flagFromCode(code);
      expect(flag.code).toBe(code);
      expect(["blocking", "caution"]).toContain(flag.tier);
      // Chip text: short and lowercase-led.
      expect(flag.label.split(" ").length).toBeLessThanOrEqual(5);
      expect(flag.label).not.toMatch(/^[A-Z]/);
      // Detail: one sentence naming a consequence, never a verdict word.
      expect(flag.detail.length).toBeGreaterThan(20);
      expect(flag.detail).not.toMatch(/\bscam\b|\brug\b|\bfraud\b/i);
      expect(flag.detail).not.toMatch(/\bsafe\b/i);
    }
  });

  it("marks exactly the honeypot- and seizable-tier codes as blocking", () => {
    const blocking = all.filter(isBlockingCode);
    expect(blocking.sort()).toEqual(
      [
        "default-frozen",
        "freeze-authority",
        "no-sells",
        "non-transferable",
        "permanent-delegate",
        "transfer-fee-extreme",
        "transfer-hook",
      ].sort()
    );
  });
});
