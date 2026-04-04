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

function heliusApiKey(): string | null {
  return process.env.HELIUS_API_KEY?.trim() || null;
}

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
  result?: { items?: DasAsset[]; total?: number };
}

async function fetchHoldings(address: string): Promise<WalletHolding[]> {
  const url = heliusRpcUrl();
  if (!url) return [];

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "wallet-holdings",
    method: "getAssetsByOwner",
    params: {
      ownerAddress: address,
      displayOptions: { showFungible: true, showNativeBalance: true },
      sortBy: { sortBy: "recent_action", sortDirection: "desc" },
      limit: 100,
    },
  });

  try {
    const data = (await fetchWithTimeout(url, HELIUS_TIMEOUT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })) as DasResponse;

    const items = data?.result?.items ?? [];
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

    return holdings;
  } catch {
    return [];
  }
}

// ── Enhanced Transactions ──────────────────────────────────────────

interface EnhancedTx {
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

async function fetchEnhancedTransactions(
  address: string
): Promise<EnhancedTx[]> {
  const base = heliusRestBase();
  const key = heliusApiKey();
  if (!base || !key) return [];

  const all: EnhancedTx[] = [];
  let beforeSig: string | undefined;

  for (let page = 0; page < WALLET_TX_PAGES; page++) {
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
    } catch {
      break;
    }
  }

  return all;
}

// ── Swap P&L computation ───────────────────────────────────────────

interface MintAccum {
  name: string;
  symbol: string;
  totalBoughtSol: number;
  totalSoldSol: number;
  firstBuyMs: number;
  lastActivityMs: number;
}

function parseSwaps(
  txs: EnhancedTx[],
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
        firstBuyMs: 0,
        lastActivityMs: 0,
      };
      map.set(mint, acc);
    }
    return acc;
  }

  for (const tx of txs) {
    if (tx.type !== "SWAP" || !tx.events?.swap) continue;

    const swap = tx.events.swap;
    const tsMs = tx.timestamp * 1000;

    const nativeInLam = swap.nativeInput
      ? Number(swap.nativeInput.amount)
      : 0;
    const nativeOutLam = swap.nativeOutput
      ? Number(swap.nativeOutput.amount)
      : 0;

    if (nativeInLam > 0 && swap.tokenOutputs && swap.tokenOutputs.length > 0) {
      const solSpent = nativeInLam / LAMPORTS;
      for (const tok of swap.tokenOutputs) {
        if (tok.mint === SOL_MINT) continue;
        const acc = getOrCreate(tok.mint);
        acc.totalBoughtSol += solSpent / swap.tokenOutputs.length;
        if (acc.firstBuyMs === 0 || tsMs < acc.firstBuyMs)
          acc.firstBuyMs = tsMs;
        if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
      }
    }

    if (nativeOutLam > 0 && swap.tokenInputs && swap.tokenInputs.length > 0) {
      const solReceived = nativeOutLam / LAMPORTS;
      for (const tok of swap.tokenInputs) {
        if (tok.mint === SOL_MINT) continue;
        const acc = getOrCreate(tok.mint);
        acc.totalSoldSol += solReceived / swap.tokenInputs.length;
        if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
        if (acc.firstBuyMs === 0) acc.firstBuyMs = tsMs;
      }
    }
  }

  return map;
}

// ── Side wallets ───────────────────────────────────────────────────

const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  SOL_MINT,
]);

function detectSideWallets(
  txs: EnhancedTx[],
  walletAddress: string
): SideWallet[] {
  const counterparties = new Map<
    string,
    { sent: number; received: number; count: number }
  >();

  for (const tx of txs) {
    for (const nt of tx.nativeTransfers ?? []) {
      if (nt.amount <= 0) continue;

      if (
        nt.fromUserAccount === walletAddress &&
        nt.toUserAccount !== walletAddress
      ) {
        const addr = nt.toUserAccount;
        if (KNOWN_PROGRAMS.has(addr)) continue;
        const e = counterparties.get(addr) ?? {
          sent: 0,
          received: 0,
          count: 0,
        };
        e.sent += nt.amount / LAMPORTS;
        e.count++;
        counterparties.set(addr, e);
      }
      if (
        nt.toUserAccount === walletAddress &&
        nt.fromUserAccount !== walletAddress
      ) {
        const addr = nt.fromUserAccount;
        if (KNOWN_PROGRAMS.has(addr)) continue;
        const e = counterparties.get(addr) ?? {
          sent: 0,
          received: 0,
          count: 0,
        };
        e.received += nt.amount / LAMPORTS;
        e.count++;
        counterparties.set(addr, e);
      }
    }
  }

  const results: SideWallet[] = [];
  counterparties.forEach((val, addr) => {
    if (val.count < 2) return;
    const dir: SideWallet["direction"] =
      val.sent > 0 && val.received > 0
        ? "both"
        : val.sent > 0
          ? "sent"
          : "received";
    results.push({
      address: addr,
      interactionCount: val.count,
      totalSolTransferred: Math.round((val.sent + val.received) * 1000) / 1000,
      direction: dir,
    });
  });

  results.sort((a, b) => b.interactionCount - a.interactionCount);
  return results.slice(0, 20);
}

// ── Current prices via DexScreener ─────────────────────────────────

interface DexPairPrice {
  chainId: string;
  baseToken: { address: string };
  priceNative?: string;
  priceUsd?: string;
}

async function fetchCurrentPrices(
  mints: string[]
): Promise<Map<string, { priceNative: number; priceUsd: number }>> {
  const result = new Map<string, { priceNative: number; priceUsd: number }>();
  if (mints.length === 0) return result;

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
        if (result.has(mint)) continue;
        const priceNative = p.priceNative ? Number(p.priceNative) : 0;
        const priceUsd = p.priceUsd ? Number(p.priceUsd) : 0;
        if (priceNative > 0 || priceUsd > 0) {
          result.set(mint, { priceNative, priceUsd });
        }
      }
    } catch {
      /* skip batch */
    }
  }
  return result;
}

// ── Main entry point ───────────────────────────────────────────────

export async function analyzeWallet(
  address: string
): Promise<WalletAnalysis> {
  const start = Date.now();

  const [holdings, txs] = await Promise.all([
    fetchHoldings(address),
    fetchEnhancedTransactions(address),
  ]);

  const swapMap = parseSwaps(txs, holdings);

  const heldMints = holdings.map((h) => h.mint);
  const swapMints = Array.from(swapMap.keys());
  const allMints = Array.from(
    new Set([...heldMints, ...swapMints].filter((m) => m !== SOL_MINT))
  );

  const prices = await fetchCurrentPrices(allMints.slice(0, 75));

  const now = Date.now();
  const tokenPnl: TokenPnlEntry[] = [];

  swapMap.forEach((acc, mint) => {
    const holding = holdings.find((h) => h.mint === mint);
    const price = prices.get(mint);
    const holdingAmount = holding?.amount ?? 0;
    const currentValueSol =
      holdingAmount > 0 && price ? holdingAmount * price.priceNative : 0;
    const unrealizedPnlSol = currentValueSol - (acc.totalBoughtSol - acc.totalSoldSol > 0 ? acc.totalBoughtSol - acc.totalSoldSol : 0);
    const realizedPnl = acc.totalSoldSol - acc.totalBoughtSol;
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
      realizedPnlSol: Math.round(realizedPnl * 10000) / 10000,
      currentValueSol: Math.round(currentValueSol * 10000) / 10000,
      unrealizedPnlSol: Math.round(unrealizedPnlSol * 10000) / 10000,
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

  const solPrice = prices.get(SOL_MINT)?.priceUsd ?? null;
  let totalPnlUsd: number | null = null;
  if (solPrice) {
    totalPnlUsd = Math.round(totalPnlSol * solPrice * 100) / 100;
  }

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
    address,
    totalPnlSol: Math.round(totalPnlSol * 10000) / 10000,
    totalPnlUsd,
    topCoin,
    avgHoldTimeMs: Math.round(avgHoldTimeMs),
    holdings,
    tokenPnl: tokenPnl.slice(0, 50),
    sideWallets,
    txCount: txs.length,
    timing: Date.now() - start,
  };
}
