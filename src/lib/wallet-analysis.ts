import { fetchWithTimeout } from "./fetch";
import {
  WalletAnalysis,
  WalletHolding,
  TokenPnlEntry,
  SideWallet,
  HELIUS_TIMEOUT,
  WALLET_TX_PAGES,
  WALLET_TX_PER_PAGE,
  DEX_TIMEOUT,
} from "./types";

const LAMPORTS = 1e9;
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Below this, a native balance change is fee dust, not a SOL swap leg. */
const MIN_NATIVE_CHANGE_SOL = 0.005;
const MIN_NATIVE_CHANGE_LAM = MIN_NATIVE_CHANGE_SOL * LAMPORTS;

/** USDC / USDT — swaps quoted in these carry cost/proceeds in USD, not SOL. */
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

function heliusApiKey(): string | null {
  return process.env.HELIUS_API_KEY?.trim() || null;
}

// NOTE: Helius accepts the API key ONLY as the api-key query param — both the
// RPC endpoint and the v0 REST API return 401 for Authorization: Bearer and
// api-key headers (verified empirically). fetchWithTimeout deliberately omits
// URLs from error messages so the key never leaks into logs.
function heliusRpcUrl(): string | null {
  const key = heliusApiKey();
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

function heliusRestBase(): string | null {
  const key = heliusApiKey();
  if (!key) return null;
  return `https://api.helius.xyz/v0`;
}

// ── DAS: getAssetsByOwner ──────────────────────────────────────────

interface DasAsset {
  id: string;
  interface: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: {
    balance?: number;
    decimals?: number;
    price_info?: { total_price?: number; price_per_token?: number };
  };
}

interface DasResponse {
  result?: {
    items?: DasAsset[];
    total?: number;
    nativeBalance?: { lamports?: number };
  };
}

interface HoldingsResult {
  holdings: WalletHolding[];
  nativeBalanceLamports: number | null;
  failed: boolean;
}

async function fetchHoldings(address: string): Promise<HoldingsResult> {
  const url = heliusRpcUrl();
  if (!url)
    return { holdings: [], nativeBalanceLamports: null, failed: true };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "wallet-holdings",
    method: "getAssetsByOwner",
    params: {
      ownerAddress: address,
      displayOptions: { showFungible: true, showNativeBalance: true },
      sortBy: { sortBy: "recent_action", sortDirection: "desc" },
      limit: 100,
      // Required with non-id sortBy — without it Helius rejects the call
      // ("Pagination Sorting Error") and holdings silently come back empty.
      page: 1,
    },
  });

  try {
    const data = (await fetchWithTimeout(url, HELIUS_TIMEOUT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })) as DasResponse;

    // JSON-RPC errors arrive as HTTP 200 with no result — that's a failure,
    // not an empty wallet
    if (!data?.result)
      return { holdings: [], nativeBalanceLamports: null, failed: true };

    const items = data.result.items ?? [];
    const nativeBalanceLamports =
      typeof data?.result?.nativeBalance?.lamports === "number"
        ? data.result.nativeBalance.lamports
        : null;
    const holdings: WalletHolding[] = [];

    for (const a of items) {
      if (a.interface !== "FungibleToken" && a.interface !== "FungibleAsset")
        continue;
      const ti = a.token_info;
      if (!ti || !ti.balance || ti.balance <= 0) continue;

      const decimals = ti.decimals ?? 0;
      const amount = ti.balance / Math.pow(10, decimals);
      const valueUsd = ti.price_info?.total_price ?? null;

      holdings.push({
        mint: a.id,
        name: a.content?.metadata?.name ?? "Unknown",
        symbol: a.content?.metadata?.symbol ?? "???",
        amount,
        decimals,
        valueUsd,
      });
    }

    return { holdings, nativeBalanceLamports, failed: false };
  } catch {
    return { holdings: [], nativeBalanceLamports: null, failed: true };
  }
}

// ── Enhanced Transactions ──────────────────────────────────────────

/** Exported for tests. */
export interface EnhancedTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  nativeTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
  tokenTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    tokenStandard?: string;
  }[];
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: {
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
        userAccount: string;
      }[];
      tokenOutputs?: {
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
        userAccount: string;
      }[];
    };
  };
  accountData?: { account: string; nativeBalanceChange: number }[];
}

interface TxFetchResult {
  txs: EnhancedTx[];
  failed: boolean;
  truncated: boolean;
  /** Cursor for even older history: oldest fetched signature when truncated */
  nextBefore: string | null;
}

async function fetchEnhancedTransactions(
  address: string,
  before?: string
): Promise<TxFetchResult> {
  const base = heliusRestBase();
  const key = heliusApiKey();
  if (!base || !key)
    return { txs: [], failed: true, truncated: false, nextBefore: null };

  const all: EnhancedTx[] = [];
  let beforeSig: string | undefined = before;
  let failed = false;
  let truncated = false;

  for (let page = 0; page < WALLET_TX_PAGES; page++) {
    // This REST endpoint only accepts the key as a query param (headers → 401).
    let url = `${base}/addresses/${address}/transactions?api-key=${encodeURIComponent(key)}&limit=${WALLET_TX_PER_PAGE}`;
    if (beforeSig) url += `&before=${beforeSig}`;

    try {
      const data = (await fetchWithTimeout(
        url,
        HELIUS_TIMEOUT
      )) as EnhancedTx[];
      if (!Array.isArray(data) || data.length === 0) break;

      all.push(...data);
      beforeSig = data[data.length - 1].signature;
      if (data.length < WALLET_TX_PER_PAGE) break;
      // Full final page — assume more history beyond the window
      if (page === WALLET_TX_PAGES - 1) truncated = true;
    } catch {
      failed = true;
      break;
    }
  }

  return {
    txs: all,
    failed,
    truncated,
    nextBefore: truncated && beforeSig ? beforeSig : null,
  };
}

// ── Swap P&L computation ───────────────────────────────────────────

interface MintAccum {
  name: string;
  symbol: string;
  totalBoughtSol: number;
  totalSoldSol: number;
  /** Token quantity in UI (decimal-adjusted) units; 0 when unknown. */
  qtyBought: number;
  qtySold: number;
  /** USD legs from USDC/USDT-quoted swaps — converted to SOL post-parse. */
  costUsdStable: number;
  proceedsUsdStable: number;
  /** True once any stable-quoted leg contributed (valued at current SOL px). */
  approxUsd: boolean;
  firstBuyMs: number;
  lastActivityMs: number;
}

/** Weighted-average-cost P&L inputs — accumulator totals plus current value. */
export interface PnlInput {
  totalBoughtSol: number;
  totalSoldSol: number;
  qtyBought: number;
  qtySold: number;
  currentValueSol: number;
}

export interface PnlResult {
  avgCostSol: number | null;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  remainingQty: number;
  remainingBasisSol: number;
  basisIncomplete: boolean;
}

/**
 * Weighted-average-cost P&L. Exported for tests — pure math, no I/O.
 * When buy quantities are unknown (qtyBought = 0) falls back to crude
 * net-flow math: realized = sold - bought, unrealized = current value.
 * Invariant (qtySold <= qtyBought): realized + unrealized ===
 * totalSoldSol - totalBoughtSol + currentValueSol.
 */
export function computePnl(i: PnlInput): PnlResult {
  const { totalBoughtSol, totalSoldSol, qtyBought, qtySold, currentValueSol } =
    i;

  if (qtyBought <= 0) {
    return {
      avgCostSol: null,
      realizedPnlSol: totalSoldSol - totalBoughtSol,
      unrealizedPnlSol: currentValueSol,
      remainingQty: 0,
      remainingBasisSol: 0,
      basisIncomplete: qtySold > 0,
    };
  }

  const avgCostSol = totalBoughtSol / qtyBought;
  const basisOfSold = Math.min(qtySold, qtyBought) * avgCostSol;
  const remainingQty = Math.max(0, qtyBought - qtySold);
  const remainingBasisSol = remainingQty * avgCostSol;
  return {
    avgCostSol,
    realizedPnlSol: totalSoldSol - basisOfSold,
    unrealizedPnlSol: currentValueSol - remainingBasisSol,
    remainingQty,
    remainingBasisSol,
    // Absolute + relative epsilon: quantities can be 1e9+ where FP
    // accumulation error exceeds any fixed absolute threshold.
    basisIncomplete: qtySold > qtyBought * (1 + 1e-9) + 1e-6,
  };
}

/** Exported for tests — pure function over parsed Helius transactions. */
export function parseSwaps(
  txs: EnhancedTx[],
  walletAddress: string,
  holdings: WalletHolding[]
): Map<string, MintAccum> {
  const map = new Map<string, MintAccum>();

  const holdingNames = new Map<string, { name: string; symbol: string }>();
  for (const h of holdings) {
    holdingNames.set(h.mint, { name: h.name, symbol: h.symbol });
  }

  function getOrCreate(mint: string): MintAccum {
    let acc = map.get(mint);
    if (!acc) {
      const meta = holdingNames.get(mint);
      acc = {
        name: meta?.name ?? "Unknown",
        symbol: meta?.symbol ?? "???",
        totalBoughtSol: 0,
        totalSoldSol: 0,
        qtyBought: 0,
        qtySold: 0,
        costUsdStable: 0,
        proceedsUsdStable: 0,
        approxUsd: false,
        firstBuyMs: 0,
        lastActivityMs: 0,
      };
      map.set(mint, acc);
    }
    return acc;
  }

  let buyCount = 0;
  let sellCount = 0;

  // qty is the token quantity in UI units — 0 when unknown.
  function recordBuy(mint: string, solAmount: number, qty: number, tsMs: number) {
    if (mint === SOL_MINT || STABLE_MINTS.has(mint) || solAmount <= 0) return;
    const acc = getOrCreate(mint);
    acc.totalBoughtSol += solAmount;
    if (Number.isFinite(qty) && qty > 0) acc.qtyBought += qty;
    if (acc.firstBuyMs === 0 || tsMs < acc.firstBuyMs) acc.firstBuyMs = tsMs;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
    buyCount++;
  }

  function recordSell(mint: string, solAmount: number, qty: number, tsMs: number) {
    if (mint === SOL_MINT || STABLE_MINTS.has(mint) || solAmount <= 0) return;
    const acc = getOrCreate(mint);
    acc.totalSoldSol += solAmount;
    if (Number.isFinite(qty) && qty > 0) acc.qtySold += qty;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
    if (acc.firstBuyMs === 0) acc.firstBuyMs = tsMs;
    sellCount++;
  }

  // Stable-quoted legs: cost/proceeds land in USD accumulators and are
  // converted to SOL once the current SOL price is known (post-parse).
  function recordStableBuy(mint: string, usd: number, qty: number, tsMs: number) {
    if (mint === SOL_MINT || STABLE_MINTS.has(mint) || usd <= 0) return;
    const acc = getOrCreate(mint);
    acc.costUsdStable += usd;
    acc.approxUsd = true;
    if (Number.isFinite(qty) && qty > 0) acc.qtyBought += qty;
    if (acc.firstBuyMs === 0 || tsMs < acc.firstBuyMs) acc.firstBuyMs = tsMs;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
    buyCount++;
  }

  function recordStableSell(mint: string, usd: number, qty: number, tsMs: number) {
    if (mint === SOL_MINT || STABLE_MINTS.has(mint) || usd <= 0) return;
    const acc = getOrCreate(mint);
    acc.proceedsUsdStable += usd;
    acc.approxUsd = true;
    if (Number.isFinite(qty) && qty > 0) acc.qtySold += qty;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
    if (acc.firstBuyMs === 0) acc.firstBuyMs = tsMs;
    sellCount++;
  }

  /** events.swap leg quantity: raw amount / 10^decimals → UI units.
   *  Live Helius legs sometimes omit rawTokenAmount — treat as unknown (0). */
  function rawQty(t: {
    rawTokenAmount?: { tokenAmount?: string; decimals?: number };
  }): number {
    const raw = t?.rawTokenAmount;
    if (!raw || raw.tokenAmount == null || raw.decimals == null) return 0;
    const q = Number(raw.tokenAmount) / Math.pow(10, raw.decimals);
    return Number.isFinite(q) && q > 0 ? q : 0;
  }

  for (const tx of txs) {
    const tsMs = tx.timestamp * 1000;
    let parsed = false;

    // Strategy 1: Use events.swap if available (most accurate)
    if (tx.events?.swap) {
      const swap = tx.events.swap;
      let nativeInLam = swap.nativeInput
        ? Number(swap.nativeInput.amount)
        : 0;
      let nativeOutLam = swap.nativeOutput
        ? Number(swap.nativeOutput.amount)
        : 0;

      // Pump.fun and some DEXes don't populate nativeInput/nativeOutput —
      // compute from accountData (most reliable) or nativeTransfers
      if (nativeInLam === 0 || nativeOutLam === 0) {
        let walletChangeLam = 0;
        if (tx.accountData) {
          const wd = tx.accountData.find(
            (a) => a.account === walletAddress
          );
          if (wd) walletChangeLam = wd.nativeBalanceChange;
        }
        if (walletChangeLam === 0 && tx.nativeTransfers) {
          let solOut = 0;
          let solIn = 0;
          for (const nt of tx.nativeTransfers) {
            if (nt.fromUserAccount === walletAddress && nt.amount > 0)
              solOut += nt.amount;
            if (nt.toUserAccount === walletAddress && nt.amount > 0)
              solIn += nt.amount;
          }
          walletChangeLam = solIn - solOut;
        }
        // Noise floor: a sub-0.005 SOL change is fee dust (e.g. a USDC-quoted
        // swap), not a SOL leg — don't record it as cost basis
        if (nativeInLam === 0 && walletChangeLam < -MIN_NATIVE_CHANGE_LAM)
          nativeInLam = Math.abs(walletChangeLam);
        if (nativeOutLam === 0 && walletChangeLam > MIN_NATIVE_CHANGE_LAM)
          nativeOutLam = walletChangeLam;
      }

      if (nativeInLam > 0) {
        const solSpent = nativeInLam / LAMPORTS;
        if (swap.tokenOutputs && swap.tokenOutputs.length > 0) {
          for (const tok of swap.tokenOutputs) {
            recordBuy(
              tok.mint,
              solSpent / swap.tokenOutputs.length,
              rawQty(tok),
              tsMs
            );
          }
          parsed = true;
        } else if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
          // tokenTransfers.tokenAmount is ALREADY decimal-adjusted
          const tIn: { mint: string; amount: number }[] = [];
          for (const tt of tx.tokenTransfers) {
            if (
              tt.toUserAccount === walletAddress &&
              tt.mint !== SOL_MINT &&
              tt.tokenAmount > 0
            ) {
              tIn.push({ mint: tt.mint, amount: tt.tokenAmount });
            }
          }
          if (tIn.length > 0) {
            for (const t of tIn) {
              recordBuy(t.mint, solSpent / tIn.length, t.amount, tsMs);
            }
            parsed = true;
          }
        }
      }

      if (nativeOutLam > 0) {
        const solReceived = nativeOutLam / LAMPORTS;
        if (swap.tokenInputs && swap.tokenInputs.length > 0) {
          for (const tok of swap.tokenInputs) {
            recordSell(
              tok.mint,
              solReceived / swap.tokenInputs.length,
              rawQty(tok),
              tsMs
            );
          }
          parsed = true;
        } else if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
          // events.swap missing tokenInputs — get tokens from tokenTransfers
          const tOut: { mint: string; amount: number }[] = [];
          for (const tt of tx.tokenTransfers) {
            if (
              tt.fromUserAccount === walletAddress &&
              tt.mint !== SOL_MINT &&
              tt.tokenAmount > 0
            ) {
              tOut.push({ mint: tt.mint, amount: tt.tokenAmount });
            }
          }
          if (tOut.length > 0) {
            for (const t of tOut) {
              recordSell(t.mint, solReceived / tOut.length, t.amount, tsMs);
            }
            parsed = true;
          }
        }
      }

      // Stable-quoted swap: no SOL leg cleared the noise floor, but a
      // USDC/USDT leg carries the cost/proceeds in USD. rawQty on a stable
      // leg (6 decimals) IS the USD amount.
      if (!parsed) {
        const sIns = swap.tokenInputs ?? [];
        const sOuts = swap.tokenOutputs ?? [];
        if (nativeInLam === 0) {
          let usdIn = 0;
          for (const t of sIns) {
            if (STABLE_MINTS.has(t.mint)) usdIn += rawQty(t);
          }
          const outs = sOuts.filter(
            (t) => !STABLE_MINTS.has(t.mint) && t.mint !== SOL_MINT
          );
          if (usdIn > 0 && outs.length > 0) {
            for (const t of outs) {
              recordStableBuy(t.mint, usdIn / outs.length, rawQty(t), tsMs);
            }
            parsed = true;
          }
        }
        if (nativeOutLam === 0) {
          let usdOut = 0;
          for (const t of sOuts) {
            if (STABLE_MINTS.has(t.mint)) usdOut += rawQty(t);
          }
          const ins = sIns.filter(
            (t) => !STABLE_MINTS.has(t.mint) && t.mint !== SOL_MINT
          );
          if (usdOut > 0 && ins.length > 0) {
            for (const t of ins) {
              recordStableSell(t.mint, usdOut / ins.length, rawQty(t), tsMs);
            }
            parsed = true;
          }
        }
      }
    }

    // Strategy 2: Infer from tokenTransfers + wallet SOL balance change
    if (!parsed && tx.tokenTransfers && tx.tokenTransfers.length > 0) {
      // Use accountData.nativeBalanceChange — most reliable SOL signal
      let walletSolChangeLam = 0;
      if (tx.accountData) {
        const wd = tx.accountData.find(
          (a) => a.account === walletAddress
        );
        if (wd) walletSolChangeLam = wd.nativeBalanceChange;
      }

      // Fallback to nativeTransfers if accountData unavailable
      if (walletSolChangeLam === 0) {
        let solOut = 0;
        let solIn = 0;
        for (const nt of tx.nativeTransfers ?? []) {
          if (nt.fromUserAccount === walletAddress && nt.amount > 0)
            solOut += nt.amount;
          if (nt.toUserAccount === walletAddress && nt.amount > 0)
            solIn += nt.amount;
        }
        walletSolChangeLam = solIn - solOut;
      }

      const tokensIn: { mint: string; amount: number }[] = [];
      const tokensOut: { mint: string; amount: number }[] = [];
      for (const tt of tx.tokenTransfers) {
        if (tt.mint === SOL_MINT) continue;
        if (tt.tokenAmount <= 0) continue;
        if (tt.toUserAccount === walletAddress) {
          tokensIn.push({ mint: tt.mint, amount: tt.tokenAmount });
        }
        if (tt.fromUserAccount === walletAddress) {
          tokensOut.push({ mint: tt.mint, amount: tt.tokenAmount });
        }
      }

      const solChangeSol = walletSolChangeLam / LAMPORTS;

      // BUY: wallet lost SOL, received tokens (SWAP-type only)
      if (
        tx.type === "SWAP" &&
        solChangeSol < -MIN_NATIVE_CHANGE_SOL &&
        tokensIn.length > 0
      ) {
        const spent = Math.abs(solChangeSol);
        for (const t of tokensIn) {
          recordBuy(t.mint, spent / tokensIn.length, t.amount, tsMs);
        }
      }

      // SELL: wallet gained SOL, sent tokens (any tx type)
      if (solChangeSol > MIN_NATIVE_CHANGE_SOL && tokensOut.length > 0) {
        for (const t of tokensOut) {
          recordSell(t.mint, solChangeSol / tokensOut.length, t.amount, tsMs);
        }
      }
    }
  }

  if (process.env.NODE_ENV === "development") {
    console.log(`[wallet] swap parsing: ${buyCount} buys, ${sellCount} sells, ${map.size} unique tokens`);
  }
  return map;
}

// ── Side wallets ───────────────────────────────────────────────────

const KNOWN_PROGRAMS = new Set([
  // System & token programs
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJBfCvE5urgxVxdGHQgpRZSRFeyWX4RdYjMM",
  // DEX & AMM programs
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX73",
  "JUP3jqoiSqKFsR5EVfH1J4wM2fYhpDbNzLuiQgR3Akn",
  "JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9CFi",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Serum DEX
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",  // Serum v3
  "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1", // Orca v1
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca v2
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",  // Raydium route
  "27haf8L6oxUeXrHrgEgsexjSY5hbVUWEmvv9Nyxg8vQv", // Raydium v4
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // Pump.fun
  "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",  // Tensor swap
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",  // Phoenix
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", // Lifinity v2
  "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ",  // Saber
  "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky",  // Mercurial
  "FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X", // FluxBeam
  // Pump.fun related
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp18C",
  // Staking & governance
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  // Metaplex
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg",
  SOL_MINT,
]);

function collectProgramIds(txs: EnhancedTx[]): Set<string> {
  const programs = new Set<string>();
  for (const tx of txs) {
    if (tx.accountData) {
      for (const ad of tx.accountData) {
        if (ad.nativeBalanceChange === 0 && ad.account) {
          programs.add(ad.account);
        }
      }
    }
  }
  return programs;
}

function detectSideWallets(
  txs: EnhancedTx[],
  walletAddress: string
): SideWallet[] {
  const txPrograms = collectProgramIds(txs);

  const counterparties = new Map<
    string,
    { sent: number; received: number; count: number }
  >();

  const seenPerTx = new Map<string, Set<string>>();

  for (const tx of txs) {
    const sig = tx.signature;
    if (!seenPerTx.has(sig)) seenPerTx.set(sig, new Set());
    const seen = seenPerTx.get(sig)!;

    for (const nt of tx.nativeTransfers ?? []) {
      if (nt.amount <= 0) continue;

      if (
        nt.fromUserAccount === walletAddress &&
        nt.toUserAccount !== walletAddress
      ) {
        const addr = nt.toUserAccount;
        if (KNOWN_PROGRAMS.has(addr) || txPrograms.has(addr)) continue;
        const e = counterparties.get(addr) ?? {
          sent: 0,
          received: 0,
          count: 0,
        };
        e.sent += nt.amount / LAMPORTS;
        if (!seen.has(addr)) {
          e.count++;
          seen.add(addr);
        }
        counterparties.set(addr, e);
      }
      if (
        nt.toUserAccount === walletAddress &&
        nt.fromUserAccount !== walletAddress
      ) {
        const addr = nt.fromUserAccount;
        if (KNOWN_PROGRAMS.has(addr) || txPrograms.has(addr)) continue;
        const e = counterparties.get(addr) ?? {
          sent: 0,
          received: 0,
          count: 0,
        };
        e.received += nt.amount / LAMPORTS;
        if (!seen.has(addr)) {
          e.count++;
          seen.add(addr);
        }
        counterparties.set(addr, e);
      }
    }
  }

  const results: SideWallet[] = [];
  counterparties.forEach((val, addr) => {
    const totalSol =
      Math.round((val.sent + val.received) * 1000) / 1000;
    if (val.count < 2 || totalSol < 0.01) return;
    const dir: SideWallet["direction"] =
      val.sent > 0 && val.received > 0
        ? "both"
        : val.sent > 0
          ? "sent"
          : "received";
    results.push({
      address: addr,
      interactionCount: val.count,
      totalSolTransferred: totalSol,
      direction: dir,
    });
  });

  results.sort((a, b) => b.totalSolTransferred - a.totalSolTransferred);
  return results.slice(0, 3);
}

// ── Current prices via DexScreener ─────────────────────────────────

interface DexPairPrice {
  chainId: string;
  baseToken: { address: string; name?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
}

interface TokenMeta {
  name: string;
  symbol: string;
}

interface PriceResult {
  prices: Map<string, { priceNative: number; priceUsd: number }>;
  names: Map<string, TokenMeta>;
}

async function fetchCurrentPrices(mints: string[]): Promise<PriceResult> {
  const prices = new Map<string, { priceNative: number; priceUsd: number }>();
  const names = new Map<string, TokenMeta>();
  if (mints.length === 0) return { prices, names };

  const BATCH = 25;
  for (let i = 0; i < mints.length; i += BATCH) {
    const chunk = mints.slice(i, i + BATCH);
    const url = `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`;
    try {
      const data = (await fetchWithTimeout(
        url,
        DEX_TIMEOUT
      )) as DexPairPrice[];
      if (!Array.isArray(data)) continue;
      for (const p of data) {
        if (p.chainId !== "solana") continue;
        const mint = p.baseToken.address;
        if (!prices.has(mint)) {
          const priceNative = p.priceNative ? Number(p.priceNative) : 0;
          const priceUsd = p.priceUsd ? Number(p.priceUsd) : 0;
          if (priceNative > 0 || priceUsd > 0) {
            prices.set(mint, { priceNative, priceUsd });
          }
        }
        if (!names.has(mint) && p.baseToken.name) {
          names.set(mint, {
            name: p.baseToken.name,
            symbol: p.baseToken.symbol ?? "???",
          });
        }
      }
    } catch {
      /* skip batch */
    }
  }
  return { prices, names };
}

// ── Helius DAS: getAssetBatch for token metadata ───────────────────

async function fetchTokenMetadata(
  mints: string[]
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const url = heliusRpcUrl();
  if (!url || mints.length === 0) return result;

  const BATCH = 50;
  for (let i = 0; i < mints.length; i += BATCH) {
    const chunk = mints.slice(i, i + BATCH);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "token-meta",
      method: "getAssetBatch",
      params: { ids: chunk },
    });

    try {
      const data = (await fetchWithTimeout(url, HELIUS_TIMEOUT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })) as { result?: DasAsset[] };

      if (!data?.result || !Array.isArray(data.result)) continue;
      for (const asset of data.result) {
        if (!asset.id || result.has(asset.id)) continue;
        const meta = asset.content?.metadata;
        if (meta?.name || meta?.symbol) {
          result.set(asset.id, {
            name: meta.name ?? "Unknown",
            symbol: meta.symbol ?? "???",
          });
        }
      }
    } catch {
      /* skip batch */
    }
  }
  return result;
}

// ── Main entry point ───────────────────────────────────────────────

export interface AnalyzeWalletOptions {
  /** Previously fetched txs (newest-first) to merge before this fetch. */
  priorTxs?: EnhancedTx[];
  /** Signature cursor — fetch history strictly older than this. */
  before?: string;
}

export interface AnalyzeWalletResult {
  analysis: WalletAnalysis;
  /** Merged, deduped tx window (newest-first) — for the deep-scan cache. */
  txs: EnhancedTx[];
  /** Cursor to resume even older history, or null when exhausted. */
  nextBefore: string | null;
}

export async function analyzeWallet(
  address: string,
  opts?: AnalyzeWalletOptions
): Promise<AnalyzeWalletResult> {
  const start = Date.now();

  const [holdingsRes, txRes] = await Promise.all([
    fetchHoldings(address),
    fetchEnhancedTransactions(address, opts?.before),
  ]);
  const holdings = holdingsRes.holdings;

  // Deep scan: prepend the previously fetched window, dedupe by signature.
  let txs = txRes.txs;
  if (opts?.priorTxs && opts.priorTxs.length > 0) {
    const seen = new Set<string>();
    const merged: EnhancedTx[] = [];
    for (const t of [...opts.priorTxs, ...txRes.txs]) {
      if (!t?.signature || seen.has(t.signature)) continue;
      seen.add(t.signature);
      merged.push(t);
    }
    txs = merged;
  }

  let oldestTxMs: number | null = null;
  let oldestSig: string | null = null;
  for (const tx of txs) {
    const tsMs = tx.timestamp * 1000;
    if (oldestTxMs === null || tsMs < oldestTxMs) {
      oldestTxMs = tsMs;
      oldestSig = tx.signature;
    }
  }

  if (process.env.NODE_ENV === "development") {
    const typeCounts = new Map<string, number>();
    let withSwapEvent = 0;
    let withTokenTransfers = 0;
    for (const tx of txs) {
      typeCounts.set(tx.type, (typeCounts.get(tx.type) ?? 0) + 1);
      if (tx.events?.swap) withSwapEvent++;
      if (tx.tokenTransfers && tx.tokenTransfers.length > 0) withTokenTransfers++;
    }
    const typeStr: string[] = [];
    typeCounts.forEach((cnt, type) => typeStr.push(`${type}=${cnt}`));
    console.log(
      `[wallet] ${address.slice(0, 8)}... ${txs.length} txs, types: ${typeStr.join(", ")}, withSwapEvent=${withSwapEvent}, withTokenTransfers=${withTokenTransfers}, holdings=${holdings.length}`
    );
  }

  const swapMap = parseSwaps(txs, address, holdings);
  if (process.env.NODE_ENV === "development") {
    console.log(`[wallet] parsed ${swapMap.size} token swaps`);
  }

  const heldMints = holdings.map((h) => h.mint);
  const swapMints = Array.from(swapMap.keys());
  const allMints = Array.from(
    new Set([...heldMints, ...swapMints].filter((m) => m !== SOL_MINT))
  );

  // SOL_MINT rides along so the SOL/USD price resolves for totalPnlUsd
  const { prices, names: dexNames } = await fetchCurrentPrices([
    ...allMints.slice(0, 75),
    SOL_MINT,
  ]);

  // Collect mints still missing names after DexScreener
  const holdingNames = new Map<string, TokenMeta>();
  for (const h of holdings) {
    holdingNames.set(h.mint, { name: h.name, symbol: h.symbol });
  }

  const missingNameMints: string[] = [];
  swapMap.forEach((acc, mint) => {
    if (acc.name !== "Unknown" && acc.symbol !== "???") return;
    const dex = dexNames.get(mint);
    if (dex) {
      acc.name = dex.name;
      acc.symbol = dex.symbol;
      return;
    }
    const held = holdingNames.get(mint);
    if (held && held.name !== "Unknown") {
      acc.name = held.name;
      acc.symbol = held.symbol;
      return;
    }
    missingNameMints.push(mint);
  });

  // Fetch remaining names from Helius DAS (capped at 50 mints, ~1 credit each)
  if (missingNameMints.length > 0) {
    const heliusNames = await fetchTokenMetadata(
      missingNameMints.slice(0, 50)
    );
    heliusNames.forEach((meta, mint) => {
      const acc = swapMap.get(mint);
      if (acc && acc.name === "Unknown") {
        acc.name = meta.name;
        acc.symbol = meta.symbol;
      }
    });
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[wallet] resolved ${heliusNames.size}/${missingNameMints.length} token names via Helius DAS`
      );
    }
  }

  const now = Date.now();
  const tokenPnl: TokenPnlEntry[] = [];

  const holdingsByMint = new Map(holdings.map((h) => [h.mint, h]));

  const solPrice = prices.get(SOL_MINT)?.priceUsd ?? null;

  // Stable-quoted accumulators carry USD — convert to SOL at the CURRENT
  // price (approximate by design; rows are flagged approxUsd). Without a
  // SOL price the USD legs stay unconverted and contribute nothing.
  if (solPrice && solPrice > 0) {
    swapMap.forEach((acc) => {
      if (acc.costUsdStable > 0) {
        acc.totalBoughtSol += acc.costUsdStable / solPrice;
        acc.costUsdStable = 0;
      }
      if (acc.proceedsUsdStable > 0) {
        acc.totalSoldSol += acc.proceedsUsdStable / solPrice;
        acc.proceedsUsdStable = 0;
      }
    });
  }

  swapMap.forEach((acc, mint) => {
    const holding = holdingsByMint.get(mint);
    const price = prices.get(mint);
    const holdingAmount = holding?.amount ?? 0;
    const currentValueSol =
      holdingAmount > 0 && price ? holdingAmount * price.priceNative : 0;

    // Weighted-average-cost P&L: sold basis = min(qtySold, qtyBought) * avg
    const pnl = computePnl({
      totalBoughtSol: acc.totalBoughtSol,
      totalSoldSol: acc.totalSoldSol,
      qtyBought: acc.qtyBought,
      qtySold: acc.qtySold,
      currentValueSol,
    });

    if (
      process.env.NODE_ENV === "development" &&
      acc.qtySold <= acc.qtyBought
    ) {
      const lhs = pnl.realizedPnlSol + pnl.unrealizedPnlSol;
      const rhs = acc.totalSoldSol - acc.totalBoughtSol + currentValueSol;
      if (Math.abs(lhs - rhs) > 1e-6 + Math.abs(rhs) * 1e-9) {
        console.warn(
          `[wallet] P&L invariant violated for ${mint}: realized+unrealized=${lhs} != netFlows=${rhs}`
        );
      }
    }

    const holdTimeMs =
      acc.lastActivityMs > 0 && acc.firstBuyMs > 0
        ? (holdingAmount > 0 ? now : acc.lastActivityMs) - acc.firstBuyMs
        : 0;

    tokenPnl.push({
      mint,
      name: acc.name,
      symbol: acc.symbol,
      totalBoughtSol: Math.round(acc.totalBoughtSol * 10000) / 10000,
      totalSoldSol: Math.round(acc.totalSoldSol * 10000) / 10000,
      realizedPnlSol: Math.round(pnl.realizedPnlSol * 10000) / 10000,
      currentValueSol: Math.round(currentValueSol * 10000) / 10000,
      unrealizedPnlSol: Math.round(pnl.unrealizedPnlSol * 10000) / 10000,
      qtyBought: acc.qtyBought,
      qtySold: acc.qtySold,
      avgCostSol: pnl.avgCostSol,
      remainingQty: pnl.remainingQty,
      remainingBasisSol: Math.round(pnl.remainingBasisSol * 10000) / 10000,
      ...(acc.approxUsd ? { approxUsd: true as const } : {}),
      ...(pnl.basisIncomplete ? { basisIncomplete: true as const } : {}),
      firstBuyMs: acc.firstBuyMs,
      lastActivityMs: acc.lastActivityMs,
      holdTimeMs: Math.max(0, holdTimeMs),
    });
  });

  tokenPnl.sort(
    (a, b) =>
      b.realizedPnlSol +
      b.unrealizedPnlSol -
      (a.realizedPnlSol + a.unrealizedPnlSol)
  );

  const totalPnlSol = tokenPnl.reduce(
    (sum, t) => sum + t.realizedPnlSol + t.unrealizedPnlSol,
    0
  );

  let totalPnlUsd: number | null = null;
  if (solPrice) {
    totalPnlUsd = Math.round(totalPnlSol * solPrice * 100) / 100;
  }

  // Win rate over tokens with realized sells (win = realized P&L > 0)
  let wins = 0;
  let losses = 0;
  for (const t of tokenPnl) {
    if (t.qtySold <= 0) continue;
    if (t.realizedPnlSol > 0) wins++;
    else losses++;
  }
  const winTotal = wins + losses;
  const winRate = {
    wins,
    losses,
    pct: winTotal > 0 ? Math.round((wins / winTotal) * 100) : 0,
  };

  const topCoin =
    tokenPnl.length > 0
      ? {
          mint: tokenPnl[0].mint,
          name: tokenPnl[0].name,
          symbol: tokenPnl[0].symbol,
          pnlSol:
            Math.round(
              (tokenPnl[0].realizedPnlSol + tokenPnl[0].unrealizedPnlSol) *
                10000
            ) / 10000,
        }
      : null;

  const tokensWithHoldTime = tokenPnl.filter((t) => t.holdTimeMs > 0);
  const avgHoldTimeMs =
    tokensWithHoldTime.length > 0
      ? tokensWithHoldTime.reduce((s, t) => s + t.holdTimeMs, 0) /
        tokensWithHoldTime.length
      : 0;

  const sideWallets = detectSideWallets(txs, address);

  return {
    analysis: {
      address,
      totalPnlSol: Math.round(totalPnlSol * 10000) / 10000,
      totalPnlUsd,
      topCoin,
      avgHoldTimeMs: Math.round(avgHoldTimeMs),
      holdings,
      tokenPnl: tokenPnl.slice(0, 50),
      sideWallets,
      txCount: txs.length,
      solBalanceLamports: holdingsRes.nativeBalanceLamports ?? undefined,
      partial: holdingsRes.failed || txRes.failed,
      truncated: txRes.truncated,
      oldestTxMs,
      oldestSig,
      winRate,
      timing: Date.now() - start,
    },
    txs,
    nextBefore: txRes.nextBefore,
  };
}
