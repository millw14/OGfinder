import { fetchWithTimeout } from "./fetch";

const BIRDEYE_BASE = "https://public-api.birdeye.so";
const BIRDEYE_TIMEOUT = 10000;

function apiKey(): string | undefined {
  return process.env.BIRDEYE_API_KEY || undefined;
}

function birdeyeHeaders(): Record<string, string> {
  const key = apiKey();
  if (!key) return {};
  return {
    "X-API-KEY": key,
    "x-chain": "solana",
  };
}

export function hasBirdeyeKey(): boolean {
  return !!apiKey();
}

interface BirdeyeSearchToken {
  address: string;
  name?: string;
  symbol?: string;
}

interface BirdeyeSearchResponse {
  success: boolean;
  data?: { items?: BirdeyeSearchToken[] };
}

export async function searchBirdeye(
  keyword: string
): Promise<BirdeyeSearchToken[]> {
  if (!apiKey()) return [];
  try {
    const url = `${BIRDEYE_BASE}/defi/v3/search?chain=solana&keyword=${encodeURIComponent(keyword)}&target=token`;
    const data = (await fetchWithTimeout(url, BIRDEYE_TIMEOUT, {
      headers: birdeyeHeaders(),
    })) as BirdeyeSearchResponse;
    return data?.data?.items ?? [];
  } catch {
    return [];
  }
}

interface BirdeyeExtensions {
  website?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  medium?: string;
  description?: string;
}

interface BirdeyeTokenMeta {
  address: string;
  name?: string;
  symbol?: string;
  extensions?: BirdeyeExtensions;
}

interface BirdeyeMetaSingleResponse {
  success: boolean;
  data?: BirdeyeTokenMeta;
}

interface BirdeyeMetaMultipleResponse {
  success: boolean;
  data?: Record<string, BirdeyeTokenMeta>;
}

/** Fetch metadata for up to 50 mints. Returns a map of mint → extensions URLs. */
export async function getBirdeyeMetadataMultiple(
  mints: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!apiKey() || mints.length === 0) return result;

  const chunk = mints.slice(0, 50);
  const listParam = chunk.join(",");
  try {
    const url = `${BIRDEYE_BASE}/defi/v3/token/meta-data/multiple?list_address=${encodeURIComponent(listParam)}`;
    const data = (await fetchWithTimeout(url, BIRDEYE_TIMEOUT, {
      headers: birdeyeHeaders(),
    })) as BirdeyeMetaMultipleResponse;
    if (data?.success && data.data) {
      for (const [mint, meta] of Object.entries(data.data)) {
        const urls: string[] = [];
        if (meta.extensions?.website) urls.push(meta.extensions.website);
        if (meta.extensions?.twitter) urls.push(meta.extensions.twitter);
        if (meta.extensions?.discord) urls.push(meta.extensions.discord);
        if (meta.extensions?.telegram) urls.push(meta.extensions.telegram);
        if (meta.extensions?.medium) urls.push(meta.extensions.medium);
        if (urls.length > 0) result.set(mint, urls);
      }
    }
  } catch {
    /* Birdeye unavailable */
  }
  return result;
}

export async function getBirdeyeMetadataSingle(
  mint: string
): Promise<string[]> {
  if (!apiKey()) return [];
  try {
    const url = `${BIRDEYE_BASE}/defi/v3/token/meta-data/single?address=${encodeURIComponent(mint)}`;
    const data = (await fetchWithTimeout(url, BIRDEYE_TIMEOUT, {
      headers: birdeyeHeaders(),
    })) as BirdeyeMetaSingleResponse;
    const ext = data?.data?.extensions;
    if (!ext) return [];
    const urls: string[] = [];
    if (ext.website) urls.push(ext.website);
    if (ext.twitter) urls.push(ext.twitter);
    if (ext.discord) urls.push(ext.discord);
    if (ext.telegram) urls.push(ext.telegram);
    if (ext.medium) urls.push(ext.medium);
    return urls;
  } catch {
    return [];
  }
}

interface BirdeyeNewListingToken {
  address: string;
  name?: string;
  symbol?: string;
}

interface BirdeyeNewListingResponse {
  success: boolean;
  data?: { items?: BirdeyeNewListingToken[] };
}

/** Fetch recently listed tokens from Birdeye. Returns mint addresses. */
export async function getBirdeyeNewListings(): Promise<string[]> {
  if (!apiKey()) return [];
  try {
    const url = `${BIRDEYE_BASE}/defi/v2/tokens/new_listing?limit=50`;
    const data = (await fetchWithTimeout(url, BIRDEYE_TIMEOUT, {
      headers: birdeyeHeaders(),
    })) as BirdeyeNewListingResponse;
    return (data?.data?.items ?? [])
      .map((t) => t.address)
      .filter(Boolean);
  } catch {
    return [];
  }
}
