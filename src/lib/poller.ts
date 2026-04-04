import { upsertTokenLinks, countIndexedTokens } from "./url-index";
import { fetchWithTimeout } from "./fetch";
import {
  getBirdeyeNewListings,
  getBirdeyeMetadataMultiple,
  hasBirdeyeKey,
} from "./birdeye";

const POLL_INTERVAL_MS = 30_000;
const GECKO_TIMEOUT = 10_000;
const DEX_TIMEOUT = 10_000;

let started = false;

interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  links?: { url?: string; type?: string; label?: string }[];
}

interface GeckoTokenInfo {
  id: string;
  type: string;
  attributes: {
    address: string;
    name?: string;
    symbol?: string;
    websites?: string[];
    discord_url?: string;
    telegram_handle?: string;
    twitter_handle?: string;
  };
  relationships?: {
    network?: { data?: { id?: string } };
  };
}

interface GeckoResponse {
  data?: GeckoTokenInfo[];
}

interface GeckoPoolInfo {
  id: string;
  type: string;
  attributes: {
    name?: string;
    address?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
}

interface GeckoPoolResponse {
  data?: GeckoPoolInfo[];
  included?: GeckoTokenInfo[];
}

function isSolanaGeckoToken(token: GeckoTokenInfo): boolean {
  if (token.id.startsWith("solana_")) return true;
  const netId = token.relationships?.network?.data?.id ?? "";
  return netId === "solana";
}

function extractGeckoTokenUrls(token: GeckoTokenInfo): string[] {
  const urls: string[] = [];
  for (const w of token.attributes.websites ?? []) {
    if (w) urls.push(w);
  }
  if (token.attributes.twitter_handle) {
    urls.push(`https://x.com/${token.attributes.twitter_handle}`);
  }
  if (token.attributes.discord_url) {
    urls.push(token.attributes.discord_url);
  }
  if (token.attributes.telegram_handle) {
    urls.push(`https://t.me/${token.attributes.telegram_handle}`);
  }
  return urls;
}

async function pollDexScreenerProfiles(): Promise<number> {
  let indexed = 0;
  const endpoints = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];
  for (const ep of endpoints) {
    try {
      const data = (await fetchWithTimeout(ep, DEX_TIMEOUT)) as TokenProfile[];
      if (!Array.isArray(data)) continue;
      for (const tp of data) {
        if (tp.chainId !== "solana" || !tp.tokenAddress) continue;
        const urls: string[] = [];
        for (const link of tp.links ?? []) {
          if (link.url) urls.push(link.url);
        }
        if (urls.length > 0) {
          upsertTokenLinks(tp.tokenAddress, urls, "dexscreener");
          indexed++;
        }
      }
    } catch {
      /* endpoint unavailable */
    }
  }
  return indexed;
}

async function pollBirdeyeNewListings(): Promise<void> {
  if (!hasBirdeyeKey()) return;
  try {
    const mints = await getBirdeyeNewListings();
    if (mints.length === 0) return;
    const metaMap = await getBirdeyeMetadataMultiple(mints);
    metaMap.forEach((urls, mint) => {
      upsertTokenLinks(mint, urls, "birdeye");
    });
  } catch {
    /* birdeye unavailable */
  }
}

async function pollGeckoRecentTokens(): Promise<number> {
  let indexed = 0;
  try {
    const url =
      "https://api.geckoterminal.com/api/v2/tokens/info_recently_updated";
    const data = (await fetchWithTimeout(url, GECKO_TIMEOUT)) as GeckoResponse;
    if (!Array.isArray(data?.data)) return 0;
    for (const token of data.data) {
      if (!isSolanaGeckoToken(token)) continue;
      const addr = token.attributes.address;
      if (!addr) continue;
      const urls = extractGeckoTokenUrls(token);
      if (urls.length > 0) {
        upsertTokenLinks(addr, urls, "geckoterminal");
        indexed++;
      }
    }
  } catch {
    /* gecko unavailable */
  }
  return indexed;
}

async function pollGeckoNewPools(): Promise<number> {
  let indexed = 0;
  try {
    const url =
      "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1";
    const data = (await fetchWithTimeout(
      url,
      GECKO_TIMEOUT
    )) as GeckoPoolResponse;
    if (!Array.isArray(data?.data)) return 0;
    const addresses: string[] = [];
    for (const pool of data.data) {
      const baseId = pool.relationships?.base_token?.data?.id;
      if (baseId && baseId.startsWith("solana_")) {
        addresses.push(baseId.replace("solana_", ""));
      }
    }
    if (addresses.length === 0) return 0;
    const unique = Array.from(new Set(addresses));
    for (let i = 0; i < unique.length; i += 25) {
      const chunk = unique.slice(i, i + 25);
      const dexUrl = `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`;
      try {
        const pairs = (await fetchWithTimeout(dexUrl, DEX_TIMEOUT)) as Array<{
          chainId: string;
          baseToken: { address: string };
          info?: {
            websites?: { url?: string }[];
            socials?: { url?: string }[];
          };
        }>;
        if (!Array.isArray(pairs)) continue;
        for (const p of pairs) {
          if (p.chainId !== "solana" || !p.baseToken?.address) continue;
          const urls: string[] = [];
          for (const w of p.info?.websites ?? []) {
            if (w?.url) urls.push(w.url);
          }
          for (const s of p.info?.socials ?? []) {
            if (s?.url) urls.push(s.url);
          }
          if (urls.length > 0) {
            upsertTokenLinks(p.baseToken.address, urls, "geckoterminal-newpool");
            indexed++;
          }
        }
      } catch {
        /* dex batch failed */
      }
    }
  } catch {
    /* gecko unavailable */
  }
  return indexed;
}

async function tick(): Promise<void> {
  const isDev = process.env.NODE_ENV === "development";
  try {
    const [dexCount, , geckoRecentCount, geckoPoolCount] = await Promise.all([
      pollDexScreenerProfiles(),
      pollBirdeyeNewListings(),
      pollGeckoRecentTokens(),
      pollGeckoNewPools(),
    ]);
    if (isDev) {
      let total = 0;
      try { total = countIndexedTokens(); } catch { /* */ }
      console.log(
        `[poller] tick: dex=${dexCount} geckoRecent=${geckoRecentCount} geckoPools=${geckoPoolCount} birdeye=${hasBirdeyeKey() ? "enabled" : "no-key"} | total indexed: ${total}`
      );
    }
  } catch (err) {
    if (isDev) console.error("[poller] tick error:", err);
  }
}

export function ensurePollerStarted(): void {
  if (started) return;
  started = true;
  const isDev = process.env.NODE_ENV === "development";
  if (isDev) console.log("[poller] starting background poller");
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}
