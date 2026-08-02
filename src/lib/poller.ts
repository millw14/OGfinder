import {
  getDb,
  upsertTokenLinks,
  countIndexedTokens,
  getPollState,
  setPollState,
} from "./url-index";
import { maintenanceTick } from "./store";
import { fetchWithTimeout } from "./fetch";
import {
  getBirdeyeNewListingTokens,
  getBirdeyeMetadataMultiple,
  hasBirdeyeKey,
} from "./birdeye";
import {
  recordDiscoveredTokens,
  getUnnamedRecentMints,
  resolveNamesViaDex,
  pruneDiscoveredTokens,
  type DiscoveryInput,
  type NewDiscovery,
} from "./discovery";
import { dexPairCreatedMs } from "./normalize";
import { matchDiscoveriesAgainstWatches } from "./watches";
import { pruneSnapshots } from "./snapshots";
import { sendPendingTelegramAlerts } from "./telegram";

const POLL_INTERVAL_MS = 30_000;
const GECKO_TIMEOUT = 10_000;
const DEX_TIMEOUT = 10_000;

interface PollerState {
  started: boolean;
  ticking: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastTickMs: number;
}

// State lives on globalThis so dev HMR module reloads can't spawn a second
// loop. NOTE: editing this file in dev does NOT hot-swap the running loop —
// the old closure keeps running until the dev server is restarted.
const G = globalThis as typeof globalThis & { __ogfinderPoller?: PollerState };

function getPollerState(): PollerState {
  if (!G.__ogfinderPoller) {
    G.__ogfinderPoller = {
      started: false,
      ticking: false,
      timer: null,
      lastTickMs: 0,
    };
  }
  return G.__ogfinderPoller;
}

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

async function pollDexScreenerProfiles(sink: NewDiscovery[]): Promise<number> {
  let indexed = 0;
  const endpoints = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];
  for (const ep of endpoints) {
    try {
      const data = (await fetchWithTimeout(ep, DEX_TIMEOUT)) as TokenProfile[];
      if (!Array.isArray(data)) continue;
      const discovered: DiscoveryInput[] = [];
      for (const tp of data) {
        if (tp.chainId !== "solana" || !tp.tokenAddress) continue;
        // Profiles carry no names — recorded unnamed for later resolution.
        discovered.push({ mint: tp.tokenAddress });
        const urls: string[] = [];
        for (const link of tp.links ?? []) {
          if (link.url) urls.push(link.url);
        }
        if (urls.length > 0) {
          upsertTokenLinks(tp.tokenAddress, urls, "dexscreener");
          indexed++;
        }
      }
      try {
        sink.push(...recordDiscoveredTokens(discovered, "dexscreener"));
      } catch {
        /* discovery is best-effort */
      }
    } catch {
      /* endpoint unavailable */
    }
  }
  return indexed;
}

async function pollBirdeyeNewListings(sink: NewDiscovery[]): Promise<void> {
  if (!hasBirdeyeKey()) return;
  try {
    const listings = await getBirdeyeNewListingTokens();
    if (listings.length === 0) return;
    try {
      sink.push(
        ...recordDiscoveredTokens(
          listings.map((t) => ({
            mint: t.address,
            name: t.name,
            symbol: t.symbol,
          })),
          "birdeye"
        )
      );
    } catch {
      /* discovery is best-effort */
    }
    const mints = listings.map((t) => t.address);
    const metaMap = await getBirdeyeMetadataMultiple(mints);
    metaMap.forEach((urls, mint) => {
      upsertTokenLinks(mint, urls, "birdeye");
    });
  } catch {
    /* birdeye unavailable */
  }
}

async function pollGeckoRecentTokens(sink: NewDiscovery[]): Promise<number> {
  let indexed = 0;
  try {
    const url =
      "https://api.geckoterminal.com/api/v2/tokens/info_recently_updated";
    const data = (await fetchWithTimeout(url, GECKO_TIMEOUT)) as GeckoResponse;
    if (!Array.isArray(data?.data)) return 0;
    const discovered: DiscoveryInput[] = [];
    for (const token of data.data) {
      if (!isSolanaGeckoToken(token)) continue;
      const addr = token.attributes.address;
      if (!addr) continue;
      // Discovery sees every token, including ones with no URLs.
      discovered.push({
        mint: addr,
        name: token.attributes.name,
        symbol: token.attributes.symbol,
      });
      const urls = extractGeckoTokenUrls(token);
      if (urls.length > 0) {
        upsertTokenLinks(addr, urls, "geckoterminal");
        indexed++;
      }
    }
    try {
      sink.push(...recordDiscoveredTokens(discovered, "geckoterminal"));
    } catch {
      /* discovery is best-effort */
    }
  } catch {
    /* gecko unavailable */
  }
  return indexed;
}

async function pollGeckoNewPools(sink: NewDiscovery[]): Promise<number> {
  let indexed = 0;
  // Rotate the page cursor 1→2→3→1 across ticks for wider new-pool coverage.
  let page = 1;
  try {
    const stored = Number(getPollState("gecko:new_pools:page"));
    if (stored === 2 || stored === 3) page = stored;
  } catch {
    /* poll_state unavailable — default page 1 */
  }
  try {
    setPollState("gecko:new_pools:page", String(page >= 3 ? 1 : page + 1));
  } catch {
    /* poll_state is best-effort */
  }
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`;
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
    const discovered: DiscoveryInput[] = [];
    for (let i = 0; i < unique.length; i += 25) {
      const chunk = unique.slice(i, i + 25);
      const dexUrl = `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`;
      try {
        const pairs = (await fetchWithTimeout(dexUrl, DEX_TIMEOUT)) as Array<{
          chainId: string;
          baseToken: { address: string; name?: string; symbol?: string };
          pairCreatedAt?: number;
          info?: {
            websites?: { url?: string }[];
            socials?: { url?: string }[];
          };
        }>;
        if (!Array.isArray(pairs)) continue;
        for (const p of pairs) {
          if (p.chainId !== "solana" || !p.baseToken?.address) continue;
          // Discovery sees every pair, including ones with no socials.
          discovered.push({
            mint: p.baseToken.address,
            name: p.baseToken.name,
            symbol: p.baseToken.symbol,
            pairCreatedAtMs: dexPairCreatedMs(p.pairCreatedAt),
          });
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
    try {
      sink.push(...recordDiscoveredTokens(discovered, "geckoterminal-newpool"));
    } catch {
      /* discovery is best-effort */
    }
  } catch {
    /* gecko unavailable */
  }
  return indexed;
}

/**
 * This tick's new/newly-named tokens feed the watchlist matcher, which
 * inserts in-app `alerts` rows. Best-effort — never kills a tick.
 */
function processDiscoveries(discoveries: NewDiscovery[]): void {
  try {
    matchDiscoveriesAgainstWatches(discoveries);
  } catch {
    /* alert matching is best-effort */
  }
  if (process.env.NODE_ENV === "development" && discoveries.length > 0) {
    console.log(
      `[poller] discoveries: ${discoveries.length} new/newly-named tokens`
    );
  }
}

async function tick(): Promise<void> {
  const isDev = process.env.NODE_ENV === "development";
  try {
    // Every source pushes its NewDiscovery rows here (single-threaded, safe).
    const discoveries: NewDiscovery[] = [];
    const sources: [name: string, promise: Promise<number | void>][] = [
      ["dexscreener", pollDexScreenerProfiles(discoveries)],
      ["birdeye", pollBirdeyeNewListings(discoveries)],
      ["gecko_recent", pollGeckoRecentTokens(discoveries)],
      ["gecko_new_pools", pollGeckoNewPools(discoveries)],
    ];
    const results = await Promise.allSettled(sources.map(([, p]) => p));
    const now = Date.now();
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      try {
        setPollState(`src:${sources[i][0]}:last_ok_ms`, String(now));
      } catch {
        /* poll_state is best-effort */
      }
    });
    try {
      setPollState("poller:last_tick_ms", String(now));
    } catch {
      /* poll_state is best-effort */
    }
    // Cheap name resolution for recently-discovered unnamed mints (≤2 batches).
    try {
      const unnamed = getUnnamedRecentMints(50);
      if (unnamed.length > 0) {
        const resolved = await resolveNamesViaDex(unnamed);
        if (resolved.length > 0) {
          discoveries.push(...recordDiscoveredTokens(resolved, "dexscreener"));
        }
      }
    } catch {
      /* name resolution is best-effort */
    }
    try {
      pruneDiscoveredTokens();
    } catch {
      /* prune is best-effort */
    }
    maintenanceTick();
    try {
      pruneSnapshots();
    } catch {
      /* prune is best-effort */
    }
    processDiscoveries(discoveries);
    // Pending watch-alert delivery — no-op without TELEGRAM_BOT_TOKEN and
    // swallows its own failures. Bot updates (commands, group messages) are
    // NOT handled here anymore: they arrive via the dedicated long-poll loop
    // (ensureTelegramLoopStarted in telegram.ts).
    try {
      await sendPendingTelegramAlerts();
    } catch {
      /* telegram is best-effort */
    }
    if (isDev) {
      const count = (i: number): number => {
        const r = results[i];
        return r?.status === "fulfilled" && typeof r.value === "number"
          ? r.value
          : 0;
      };
      let total = 0;
      try { total = countIndexedTokens(); } catch { /* */ }
      console.log(
        `[poller] tick: dex=${count(0)} geckoRecent=${count(2)} geckoPools=${count(3)} birdeye=${hasBirdeyeKey() ? "enabled" : "no-key"} discovered=${discoveries.length} | total indexed: ${total}`
      );
    }
  } catch (err) {
    if (isDev) console.error("[poller] tick error:", err);
  }
}

export function ensurePollerStarted(): void {
  const state = getPollerState();
  if (state.started) return;
  const isDev = process.env.NODE_ENV === "development";
  // Refuse to claim the (globalThis-shared) started flag without a working DB.
  // Turbo dev runs instrumentation.ts in a separate module graph where the
  // native better-sqlite3 binding can fail to load — a poller started there
  // would spin with every write silently failing AND block the route-fallback
  // start in the working module graph. Probe first; the context that can
  // actually reach the DB wins.
  try {
    getDb().prepare("SELECT 1").get();
  } catch {
    if (isDev) {
      console.log("[poller] DB unavailable in this context — deferring start");
    }
    return;
  }
  state.started = true;
  if (isDev) console.log("[poller] starting background poller");
  // Self-scheduling loop (no setInterval): the next run is only armed after
  // the current tick fully settles, so a slow tick can never overlap.
  const run = async (): Promise<void> => {
    if (state.ticking) return;
    state.ticking = true;
    try {
      await tick();
    } finally {
      state.ticking = false;
    }
    state.lastTickMs = Date.now();
    const jitter = Math.floor(Math.random() * 5000);
    const timer = setTimeout(run, POLL_INTERVAL_MS + jitter);
    timer.unref?.();
    state.timer = timer;
  };
  void run();
}
