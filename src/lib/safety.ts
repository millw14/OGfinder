import { FRESH_WALLET_MS, SERIAL_DEPLOYER_MIN } from "./types";

/**
 * Safety engine — PURE. Turns the signals we collected about one token into a
 * level + a list of specific, named findings.
 *
 * THE RULES THIS FILE ENCODES:
 *  1. Rank stays factual — this file never touches age or ordering. It only
 *     decides whether the oldest token has EARNED an endorsement.
 *  2. A blocking flag costs the crown. The token is still #1 by age; it just
 *     stops being called "the OG".
 *  3. Every flag names a MECHANISM and its CONSEQUENCE ("the issuer can freeze
 *     holder accounts, which blocks selling"), never a generic accusation.
 *  4. UNKNOWN IS NOT SAFE. If a check could not run, the level is "unknown" —
 *     which must never render as a clean bill of health.
 *  5. We never claim a token IS safe. The best level, "clear", means only
 *     "no blocking flags found" — an absence of findings, not a guarantee.
 */

export type SafetyLevel = "danger" | "caution" | "clear" | "unknown";

export type SafetyFlagCode =
  // blocking — honeypot-tier (you may not be able to sell at all)
  | "transfer-hook"
  | "non-transferable"
  | "default-frozen"
  | "transfer-fee-extreme"
  | "no-sells"
  // blocking — seizable-tier (someone else controls your tokens)
  | "freeze-authority"
  | "permanent-delegate"
  // caution
  | "mint-authority"
  | "transfer-fee-high"
  | "holders-concentrated"
  | "low-liquidity"
  | "mutable-metadata"
  | "lookalike-name"
  | "serial-deployer"
  | "fresh-deployer"
  | "supply-zero"
  | "few-sells";

export type SafetyTier = "blocking" | "caution";

export interface SafetyFlag {
  code: SafetyFlagCode;
  tier: SafetyTier;
  /** 3–5 word chip text, lowercase — e.g. "freeze authority active". */
  label: string;
  /** One sentence: the mechanism and what it does to a holder. */
  detail: string;
}

/** Which check groups actually ran — "clear" requires all of them. */
export interface SafetyChecks {
  /** Mint/freeze authority state was reported (DAS or on-chain mint account). */
  authorities: boolean;
  /** Token-2022 extensions were read (or the mint is not Token-2022). */
  extensions: boolean;
  /** DexScreener 24h trade counts were present. */
  trades: boolean;
}

export interface SafetyAssessment {
  level: SafetyLevel;
  flags: SafetyFlag[];
  checked: SafetyChecks;
}

// ————————————————————————— thresholds —————————————————————————
// Deliberately conservative: a false "unsafe" on a real OG is also a failure.

/** "Buys but nobody can sell" needs real buy volume — 0/0 is a DEAD token. */
export const NO_SELLS_MIN_BUYS = 10;
/** Softer "almost nobody gets out" check needs a much bigger sample. */
export const FEW_SELLS_MIN_BUYS = 50;
/** sells/buys below this (with enough buys) is the "few sells" caution. */
export const FEW_SELLS_RATIO = 0.03;
/** Transfer fee at or above 50% — a sale returns almost nothing. */
export const EXTREME_FEE_BPS = 5000;
/** Transfer fee at or above 10% — worth a warning, not a block. */
export const HIGH_FEE_BPS = 1000;
/** Top-10 accounts holding this share of supply (pools included). */
export const CONCENTRATION_PCT = 90;
/** Pooled liquidity under this is too thin to exit at a quoted price. */
export const MIN_LIQUIDITY_USD = 1000;

/**
 * Token-2022 mint extensions, as read from getAccountInfo(jsonParsed).
 * null anywhere upstream means THE CHECK DID NOT RUN — never "no extensions".
 */
export interface MintExtensionFacts {
  /** transferHook extension with a non-null programId (a null hook is inert). */
  hasTransferHook: boolean;
  nonTransferable: boolean;
  /** defaultAccountState = "frozen": new holders start frozen. */
  defaultAccountFrozen: boolean;
  /** permanentDelegate address, when one is set. */
  permanentDelegate: string | null;
  /** newerTransferFee.transferFeeBasisPoints; null = no transferFeeConfig. */
  transferFeeBps: number | null;
  isToken2022: boolean;
  /**
   * Live authorities off the same mint account read — free, and fresher than
   * the DAS index. Absent when the response carried no parsed info.
   */
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
}

/** Everything assessSafety reads. TokenResult satisfies it structurally. */
export interface SafetyInput {
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  metadataMutable?: boolean;
  topHolderPct?: number | null;
  liquidityUsd?: number | null;
  homoglyphSuspect?: true;
  supplyZero?: boolean;
  deployerTokensCreated?: number | null;
  deployerWalletFirstSeenMs?: number | null;
  buys24h?: number | null;
  sells24h?: number | null;
  /**
   * Token-2022 extension read. undefined/null = not read (unknown);
   * a value with isToken2022 false means "checked, plain SPL token".
   */
  extensions?: MintExtensionFacts | null;
}

const FLAGS: Record<SafetyFlagCode, Omit<SafetyFlag, "code">> = {
  "transfer-hook": {
    tier: "blocking",
    label: "transfer hook program",
    detail:
      "Every transfer is routed through issuer-controlled code that can reject sells.",
  },
  "non-transferable": {
    tier: "blocking",
    label: "non-transferable token",
    detail:
      "The token cannot be transferred at all, so it can never be sold or moved.",
  },
  "default-frozen": {
    tier: "blocking",
    label: "new accounts start frozen",
    detail:
      "New holder accounts are created frozen, so only wallets the issuer unfreezes can trade.",
  },
  "transfer-fee-extreme": {
    tier: "blocking",
    label: "extreme transfer fee",
    detail:
      "A transfer fee of 50% or more is taken on every transfer, so a sale returns almost nothing.",
  },
  "no-sells": {
    tier: "blocking",
    label: "buys but no sells",
    detail:
      "Buyers got in over the last 24 hours and not one sell went through — the pattern a honeypot produces.",
  },
  "freeze-authority": {
    tier: "blocking",
    label: "freeze authority active",
    detail:
      "The issuer can freeze holder accounts, which blocks selling. Some established tokens keep this power.",
  },
  "permanent-delegate": {
    tier: "blocking",
    label: "permanent delegate set",
    detail:
      "A designated address can move or burn tokens out of any wallet without the holder's approval.",
  },
  "mint-authority": {
    tier: "caution",
    label: "mint authority active",
    detail:
      "The issuer can still mint new supply at any time, diluting existing holders.",
  },
  "transfer-fee-high": {
    tier: "caution",
    label: "high transfer fee",
    detail:
      "At least 10% of every transfer is taken as a fee by the issuer.",
  },
  "holders-concentrated": {
    tier: "caution",
    label: "supply highly concentrated",
    detail:
      "The ten largest accounts hold 90%+ of supply (pools included), so one exit can crash the price.",
  },
  "low-liquidity": {
    tier: "caution",
    label: "very low liquidity",
    detail:
      "Under $1,000 sits in the pool, so even a small sell moves the price hard.",
  },
  "mutable-metadata": {
    tier: "caution",
    label: "metadata still mutable",
    detail:
      "The name, symbol, and image can be changed after launch, including into a different token's identity.",
  },
  "lookalike-name": {
    tier: "caution",
    label: "lookalike characters in name",
    detail:
      "The name uses lookalike or invisible characters that imitate another token's name.",
  },
  "serial-deployer": {
    tier: "caution",
    label: "serial token deployer",
    detail: `The deployer wallet has launched ${SERIAL_DEPLOYER_MIN}+ tokens, a pattern typical of launch farms.`,
  },
  "fresh-deployer": {
    tier: "caution",
    label: "brand-new deployer wallet",
    detail:
      "The deployer wallet first transacted less than a week ago, so it has no track record.",
  },
  "supply-zero": {
    tier: "caution",
    label: "supply is zero",
    detail:
      "On-chain supply is zero — the token was fully burned or never minted.",
  },
  "few-sells": {
    tier: "caution",
    label: "very few sells",
    detail:
      "Sells are under 3% of buys over 24 hours, which is how a hard-to-exit token trades.",
  },
};

/**
 * Rehydrate a flag from its code — the wire carries codes only, so the client
 * re-derives labels/details without shipping copy in every payload.
 */
export function flagFromCode(code: SafetyFlagCode): SafetyFlag {
  return { code, ...FLAGS[code] };
}

/** True when this code blocks the OG endorsement. */
export function isBlockingCode(code: SafetyFlagCode): boolean {
  return FLAGS[code]?.tier === "blocking";
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Assess one token. Order of the returned flags is blocking-first, then
 * caution, each group in fixed severity order — the UI can render the list
 * as-is and the first flag is always the headline finding.
 */
export function assessSafety(
  token: SafetyInput,
  now: number = Date.now()
): SafetyAssessment {
  const codes: SafetyFlagCode[] = [];

  const ext = token.extensions ?? null;
  const buys = num(token.buys24h);
  const sells = num(token.sells24h);
  const tradesKnown = buys !== null && sells !== null;

  // ——— blocking: honeypot-tier ———
  if (ext?.hasTransferHook) codes.push("transfer-hook");
  if (ext?.nonTransferable) codes.push("non-transferable");
  if (ext?.defaultAccountFrozen) codes.push("default-frozen");

  const feeBps = ext ? num(ext.transferFeeBps) : null;
  if (feeBps !== null && feeBps >= EXTREME_FEE_BPS) {
    codes.push("transfer-fee-extreme");
  }

  // "Buys but nobody can sell." 0 buys AND 0 sells is a DEAD token, never a
  // honeypot claim — hence the minimum-buys floor.
  const noSells =
    tradesKnown && buys! >= NO_SELLS_MIN_BUYS && sells === 0;
  if (noSells) codes.push("no-sells");

  // ——— blocking: seizable-tier ———
  // Legitimate assets (USDC and friends) do keep freeze authority. We still
  // withhold the endorsement — withholding is conservative — and the copy
  // states the mechanism instead of calling the token a scam.
  if (token.freezeAuthorityActive === true) codes.push("freeze-authority");
  if (ext?.permanentDelegate) codes.push("permanent-delegate");

  // ——— caution ———
  if (token.mintAuthorityActive === true) codes.push("mint-authority");
  if (feeBps !== null && feeBps >= HIGH_FEE_BPS && feeBps < EXTREME_FEE_BPS) {
    codes.push("transfer-fee-high");
  }
  const topPct = num(token.topHolderPct);
  if (topPct !== null && topPct >= CONCENTRATION_PCT) {
    codes.push("holders-concentrated");
  }
  const liq = num(token.liquidityUsd);
  if (liq !== null && liq < MIN_LIQUIDITY_USD) codes.push("low-liquidity");
  if (token.metadataMutable === true) codes.push("mutable-metadata");
  if (token.homoglyphSuspect === true) codes.push("lookalike-name");
  const created = num(token.deployerTokensCreated);
  if (created !== null && created >= SERIAL_DEPLOYER_MIN) {
    codes.push("serial-deployer");
  }
  const firstSeen = num(token.deployerWalletFirstSeenMs);
  if (firstSeen !== null && now - firstSeen < FRESH_WALLET_MS) {
    codes.push("fresh-deployer");
  }
  if (token.supplyZero === true) codes.push("supply-zero");
  // Skipped when no-sells already fired — one finding per phenomenon.
  if (
    !noSells &&
    tradesKnown &&
    buys! >= FEW_SELLS_MIN_BUYS &&
    sells! / buys! < FEW_SELLS_RATIO
  ) {
    codes.push("few-sells");
  }

  const flags = codes.map(flagFromCode);
  const checked: SafetyChecks = {
    authorities:
      token.mintAuthorityActive !== undefined ||
      token.freezeAuthorityActive !== undefined,
    // A successful read of a plain SPL mint is a completed extension check:
    // there are no Token-2022 extensions to have.
    extensions: ext !== null,
    trades: tradesKnown,
  };

  let level: SafetyLevel;
  if (flags.some((f) => f.tier === "blocking")) level = "danger";
  else if (flags.length > 0) level = "caution";
  else if (checked.authorities && checked.extensions && checked.trades) {
    // NOT a safety guarantee — only "the checks we ran found nothing".
    level = "clear";
  } else level = "unknown";

  return { level, flags, checked };
}
