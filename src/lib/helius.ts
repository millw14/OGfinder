import { HeliusSlotData, HELIUS_TIMEOUT, MAX_SIG_PAGES } from "./types";
import { fetchWithTimeout } from "./fetch";
import { getHeliusSlot, setHeliusSlot } from "./cache";

/** Public read-only fallback when HELIUS_API_KEY is missing on the server (e.g. Vercel env not set). */
const PUBLIC_MAINNET_RPC = "https://api.mainnet-beta.solana.com";

function getHeliusDasRpcUrl(): string | null {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

/**
 * Standard JSON-RPC (getAccountInfo, getSignaturesForAddress): Helius if key is set,
 * else SOLANA_RPC_URL, else public mainnet — so mint scan works without DAS credentials.
 */
function getStandardJsonRpcUrl(): string {
  return (
    getHeliusDasRpcUrl() ??
    (process.env.SOLANA_RPC_URL?.trim() || PUBLIC_MAINNET_RPC)
  );
}

async function jsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "ogfinder",
    method,
    params,
  });

  return fetchWithTimeout(url, HELIUS_TIMEOUT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  token_info?: {
    supply?: number;
  };
  supply?: {
    print_current_supply?: number;
  };
  slot?: number;
  created_at?: string;
}

interface SignatureResult {
  slot: number;
  blockTime: number;
  signature: string;
}

async function standardRpc(method: string, params: unknown): Promise<unknown> {
  return jsonRpc(getStandardJsonRpcUrl(), method, params);
}

export async function getAssetBatch(
  mints: string[]
): Promise<Map<string, HeliusSlotData>> {
  const result = new Map<string, HeliusSlotData>();

  const uncached: string[] = [];
  for (const mint of mints) {
    const cached = getHeliusSlot(mint);
    if (cached) {
      result.set(mint, {
        slot: cached.slot,
        createdAt: null,
        heliusName: null,
        heliusSymbol: null,
        tokenInterface: null,
        supply: null,
      });
    } else {
      uncached.push(mint);
    }
  }

  if (uncached.length === 0) return result;

  const dasUrl = getHeliusDasRpcUrl();
  if (!dasUrl) {
    return result;
  }

  try {
    const response = (await jsonRpc(dasUrl, "getAssetBatch", {
      ids: uncached,
    })) as { result?: HeliusAsset[] };

    const assets = response?.result;
    if (!Array.isArray(assets)) return result;

    for (const asset of assets) {
      if (!asset?.id) continue;

      const supply =
        asset.token_info?.supply ??
        asset.supply?.print_current_supply ??
        null;

      const data: HeliusSlotData = {
        slot: asset.slot ?? null,
        createdAt: asset.created_at ?? null,
        heliusName: asset.content?.metadata?.name ?? null,
        heliusSymbol: asset.content?.metadata?.symbol ?? null,
        tokenInterface: asset.interface ?? null,
        supply,
      };

      result.set(asset.id, data);

      if (data.slot != null) {
        setHeliusSlot(asset.id, { slot: data.slot, blockTime: 0 });
      }
    }
  } catch {
    // Graceful fallback — tokens without data sort by other signals
  }

  return result;
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * When DAS getAssetBatch has no record (unindexed mint), fall back to standard
 * RPC getAccountInfo(jsonParsed) to detect an SPL mint account.
 */
function parseMintFromGetAccountResponse(response: unknown): HeliusSlotData | null {
  const r = response as {
    result?: {
      value: null | {
        owner?: string;
        data?: {
          program?: string;
          parsed?: { type?: string; info?: { supply?: string } };
        };
      };
    };
    error?: { message?: string };
  };
  if (r?.error) return null;

  const value = r?.result?.value;
  if (!value || typeof value !== "object") return null;

  const owner = value.owner;
  if (owner !== SPL_TOKEN_PROGRAM && owner !== SPL_TOKEN_2022_PROGRAM) {
    return null;
  }

  const parsed = value.data?.parsed;
  if (parsed?.type !== "mint") return null;

  const supplyStr = parsed.info?.supply;
  const supply =
    supplyStr != null && supplyStr !== "" ? Number(supplyStr) : null;

  return {
    slot: null,
    createdAt: null,
    heliusName: null,
    heliusSymbol: null,
    tokenInterface: "FungibleToken",
    supply: Number.isFinite(supply) ? supply : null,
  };
}

export async function getMintHeliusDataRpcFallback(
  mint: string
): Promise<HeliusSlotData | null> {
  const params = [mint, { encoding: "jsonParsed" }];
  const urls = [
    getStandardJsonRpcUrl(),
    PUBLIC_MAINNET_RPC,
    process.env.SOLANA_RPC_URL?.trim(),
  ].filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);

  for (const url of urls) {
    try {
      const response = await jsonRpc(url, "getAccountInfo", params);
      const parsed = parseMintFromGetAccountResponse(response);
      if (parsed) return parsed;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

/**
 * Get the actual creation slot/blockTime for a mint by paginating backward
 * through getSignaturesForAddress until we find the very first transaction.
 *
 * Uses limit:1000 per page, up to MAX_SIG_PAGES pages.
 * If we get fewer than 1000 results, we've reached the beginning.
 */
export async function getCreationSlot(
  mint: string
): Promise<{ slot: number; blockTime: number } | null> {
  const cached = getHeliusSlot(mint);
  if (cached && cached.blockTime > 0) return cached;

  try {
    let before: string | undefined = undefined;
    let oldestSig: SignatureResult | null = null;

    for (let page = 0; page < MAX_SIG_PAGES; page++) {
      const params: [string, { limit: number; before?: string }] = [
        mint,
        { limit: 1000 },
      ];
      if (before) params[1].before = before;

      const response = (await standardRpc(
        "getSignaturesForAddress",
        params
      )) as { result?: SignatureResult[] };

      const sigs = response?.result;
      if (!Array.isArray(sigs) || sigs.length === 0) break;

      oldestSig = sigs[sigs.length - 1];
      before = oldestSig.signature;

      // If fewer than 1000 results, we've reached the beginning
      if (sigs.length < 1000) break;
    }

    if (!oldestSig) return null;

    const data = { slot: oldestSig.slot, blockTime: oldestSig.blockTime };
    setHeliusSlot(mint, data);
    return data;
  } catch {
    return null;
  }
}
