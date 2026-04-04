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
        firstBuyMs: 0,
        lastActivityMs: 0,
      };
      map.set(mint, acc);
    }
    return acc;
  }

  function recordBuy(mint: string, solAmount: number, tsMs: number) {
    if (mint === SOL_MINT || solAmount <= 0) return;
    const acc = getOrCreate(mint);
    acc.totalBoughtSol += solAmount;
    if (acc.firstBuyMs === 0 || tsMs < acc.firstBuyMs) acc.firstBuyMs = tsMs;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
  }

  function recordSell(mint: string, solAmount: number, tsMs: number) {
    if (mint === SOL_MINT || solAmount <= 0) return;
    const acc = getOrCreate(mint);
    acc.totalSoldSol += solAmount;
    if (tsMs > acc.lastActivityMs) acc.lastActivityMs = tsMs;
    if (acc.firstBuyMs === 0) acc.firstBuyMs = tsMs;
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

      // Pump.fun and some DEXes don't populate nativeInput/nativeOutput
      // in events.swap — compute from nativeTransfers as fallback
      if (
        (nativeInLam === 0 || nativeOutLam === 0) &&
        tx.nativeTransfers &&
        tx.nativeTransfers.length > 0
      ) {
        let solOut = 0;
        let solIn = 0;
        for (const nt of tx.nativeTransfers) {
          if (nt.fromUserAccount === walletAddress && nt.amount > 0)
            solOut += nt.amount;
          if (nt.toUserAccount === walletAddress && nt.amount > 0)
            solIn += nt.amount;
        }
        if (nativeInLam === 0 && solOut > solIn)
          nativeInLam = solOut - solIn;
        if (nativeOutLam === 0 && solIn > solOut)
          nativeOutLam = solIn - solOut;
      }

      if (
        nativeInLam > 0 &&
        swap.tokenOutputs &&
        swap.tokenOutputs.length > 0
      ) {
        const solSpent = nativeInLam / LAMPORTS;
        for (const tok of swap.tokenOutputs) {
          recordBuy(tok.mint, solSpent / swap.tokenOutputs.length, tsMs);
        }
        parsed = true;
      }

      if (
        nativeOutLam > 0 &&
        swap.tokenInputs &&
        swap.tokenInputs.length > 0
      ) {
        const solReceived = nativeOutLam / LAMPORTS;
        for (const tok of swap.tokenInputs) {
          recordSell(tok.mint, solReceived / swap.tokenInputs.length, tsMs);
        }
        parsed = true;
      }
    }

    // Strategy 2: Fallback — only for SWAP-typed txs missing events.swap
    if (!parsed && tx.type === "SWAP" && tx.tokenTransfers && tx.tokenTransfers.length > 0) {
      let solOut = 0;
      let solIn = 0;
      for (const nt of tx.nativeTransfers ?? []) {
        if (nt.fromUserAccount === walletAddress && nt.amount > 0)
          solOut += nt.amount;
        if (nt.toUserAccount === walletAddress && nt.amount > 0)
          solIn += nt.amount;
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

      const netSolOut = solOut > solIn ? (solOut - solIn) / LAMPORTS : 0;
      const netSolIn = solIn > solOut ? (solIn - solOut) / LAMPORTS : 0;

      // BUY: wallet spent SOL, received tokens
      if (netSolOut > 0.0001 && tokensIn.length > 0) {
        for (const t of tokensIn) {
          recordBuy(t.mint, netSolOut / tokensIn.length, tsMs);
        }
      }

      // SELL: wallet sent tokens, received SOL
      if (netSolIn > 0.0001 && tokensOut.length > 0) {
        for (const t of tokensOut) {
          recordSell(t.mint, netSolIn / tokensOut.length, tsMs);
        }
      }
    }
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

export async function analyzeWallet(
  address: string
): Promise<WalletAnalysis> {
  const start = Date.now();

  const [holdings, txs] = await Promise.all([
    fetchHoldings(address),
    fetchEnhancedTransactions(address),
  ]);

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

  const swapMap = parseSwaps(txs, address, holdings);
  console.log(`[wallet] parsed ${swapMap.size} token swaps`);

  const heldMints = holdings.map((h) => h.mint);
  const swapMints = Array.from(swapMap.keys());
  const allMints = Array.from(
    new Set([...heldMints, ...swapMints].filter((m) => m !== SOL_MINT))
  );

  const { prices, names: dexNames } = await fetchCurrentPrices(
    allMints.slice(0, 75)
  );

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
    console.log(
      `[wallet] resolved ${heliusNames.size}/${missingNameMints.length} token names via Helius DAS`
    );
  }

  const now = Date.now();
  const tokenPnl: TokenPnlEntry[] = [];

  swapMap.forEach((acc, mint) => {
    const holding = holdings.find((h) => h.mint === mint);
    const price = prices.get(mint);
    const holdingAmount = holding?.amount ?? 0;
    const currentValueSol =
      holdingAmount > 0 && price ? holdingAmount * price.priceNative : 0;
    // Net P&L = totalSoldSol + currentValueSol - totalBoughtSol
    // realized already includes the full cost basis, so unrealized is just current value
    const realizedPnl = acc.totalSoldSol - acc.totalBoughtSol;
    const unrealizedPnlSol = currentValueSol;
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
