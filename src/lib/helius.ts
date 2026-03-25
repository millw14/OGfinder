import { HeliusSlotData, HELIUS_TIMEOUT, MAX_SIG_PAGES } from "./types";
import { fetchWithTimeout } from "./fetch";
import { getHeliusSlot, setHeliusSlot } from "./cache";

const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

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

async function heliusRpc(method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "ogfinder",
    method,
    params,
  });

  return fetchWithTimeout(HELIUS_URL, HELIUS_TIMEOUT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
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

  try {
    const response = (await heliusRpc("getAssetBatch", {
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
export async function getMintHeliusDataRpcFallback(
  mint: string
): Promise<HeliusSlotData | null> {
  try {
    const response = (await heliusRpc("getAccountInfo", [
      mint,
      { encoding: "jsonParsed" },
    ])) as {
      result?: {
        value: null | {
          owner?: string;
          data?: {
            program?: string;
            parsed?: { type?: string; info?: { supply?: string } };
          };
        };
      };
    };

    const value = response?.result?.value;
    if (!value || typeof value !== "object") return null;

    const owner = value.owner;
    if (owner !== SPL_TOKEN_PROGRAM && owner !== SPL_TOKEN_2022_PROGRAM) {
      return null;
    }

    const parsed = value.data?.parsed;
    if (parsed?.type !== "mint") return null;

    const supplyStr = parsed.info?.supply;
    const supply =
      supplyStr != null && supplyStr !== ""
        ? Number(supplyStr)
        : null;

    return {
      slot: null,
      createdAt: null,
      heliusName: null,
      heliusSymbol: null,
      tokenInterface: "FungibleToken",
      supply: Number.isFinite(supply) ? supply : null,
    };
  } catch {
    return null;
  }
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

      const response = (await heliusRpc(
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
