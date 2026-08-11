import {
  HeliusSlotData,
  HELIUS_TIMEOUT,
  MAX_SIG_PAGES,
  OFFCHAIN_META_FAIL_TTL,
  OFFCHAIN_META_TIMEOUT,
  OffchainTokenMeta,
  TOKENS_CREATED_CAP,
} from "./types";
import { fetchWithTimeout } from "./fetch";
import {
  getHeliusMeta,
  setHeliusMeta,
  getCreationSlotCache,
  setCreationSlotCache,
  getCreationWalkProgress,
  setCreationWalkProgress,
  getMintExtensionsCache,
  setMintExtensionsCache,
  getOffchainMetaCache,
  setOffchainMetaCache,
} from "./cache";
import type { MintExtensionFacts } from "./safety";
import {
  getDeployerPersisted,
  setDeployerPersisted,
  getDeployerProfilePersisted,
  setDeployerProfilePersisted,
} from "./store";

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

/** One entry of DAS content.files. Verified live: {uri, cdn_uri, mime}. */
interface HeliusAssetFile {
  uri?: string;
  /** Helius CDN copy — resized AND proxied. Preferred when present. */
  cdn_uri?: string;
  mime?: string;
}

interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    /** Off-chain metadata JSON (socials live here for pump.fun-era mints). */
    json_uri?: string;
    links?: {
      image?: string;
    };
    files?: HeliusAssetFile[];
    metadata?: {
      name?: string;
      symbol?: string;
      description?: string;
      token_standard?: string;
    };
  };
  /** Metadata authorities; the one scoped "full" can rewrite name/image. */
  authorities?: {
    address?: string;
    scopes?: string[];
  }[];
  token_info?: {
    supply?: number;
    decimals?: number;
    /** Base58 authority when active; key omitted by DAS when revoked. */
    mint_authority?: string | null;
    freeze_authority?: string | null;
  };
  supply?: {
    print_current_supply?: number;
  };
  slot?: number;
  created_at?: string;
  /** Metaplex metadata mutability — always a boolean on DAS assets. */
  mutable?: boolean;
  /** Top-level burn flag. */
  burnt?: boolean;
}

/** Longest metadata URL we will carry. Bounds payloads; also kills data: blobs. */
const MAX_METADATA_URL = 2048;
/** On-chain descriptions are free-form text from the mint — truncate on the way in. */
const MAX_DESCRIPTION = 500;

/**
 * http/https-only guard for ATTACKER-CONTROLLED metadata URLs (token images,
 * json_uri, socials). A mint's metadata is written by whoever launched it, so
 * these strings reach an <img src> / href only after passing here.
 *
 * Rejects `data:` and `javascript:` (script-injection vectors in an href, and
 * an unbounded payload in an img), `ipfs:`/`ar:` (no browser fetches those
 * natively), protocol-relative `//host/x` and bare relative paths (which would
 * resolve against OUR origin), and anything unparseable.
 */
export function isSafeImageUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_METADATA_URL) return false;
  try {
    // No base: a relative or protocol-relative URL throws instead of silently
    // resolving against our own origin.
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Hosts a SERVER-SIDE fetch must refuse. json_uri is chosen by the token
 * deployer, so fetching it is an SSRF primitive pointed at our own network
 * unless private space is excluded.
 *
 * Honest bound: this checks the literal host only. A public hostname whose DNS
 * answer is a private address (DNS rebinding) still gets through — closing that
 * needs resolve-then-connect plumbing Node's fetch does not expose.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10)
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true; // cloud instance metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** isSafeImageUrl plus the private-address exclusion needed to FETCH a URL. */
export function isSafeFetchUrl(url: unknown): url is string {
  if (!isSafeImageUrl(url)) return false;
  try {
    return !isPrivateHost(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/** A files[] entry with no mime is accepted; a non-image mime is not. */
function isImageFile(file: HeliusAssetFile | undefined): boolean {
  if (!file) return false;
  return typeof file.mime !== "string" || file.mime.startsWith("image/");
}

/**
 * Pick a token's image from DAS content, in preference order:
 *   1. files[].cdn_uri  — Helius CDN: resized, and it PROXIES, so the visitor's
 *      browser never connects to the arbitrary host the mint named.
 *   2. links.image      — canonical image the metadata declares.
 *   3. files[].uri      — raw file, last resort.
 * Every candidate is http/https-validated; undefined = this token has no
 * usable image, which is different from "we didn't look".
 * Exported for tests.
 */
export function pickDasImageUrl(
  content: HeliusAsset["content"] | undefined
): string | undefined {
  const files = Array.isArray(content?.files) ? content!.files! : [];
  const images = files.filter(isImageFile);

  for (const file of images) {
    if (isSafeImageUrl(file.cdn_uri)) return file.cdn_uri.trim();
  }
  if (isSafeImageUrl(content?.links?.image)) {
    return content!.links!.image!.trim();
  }
  for (const file of images) {
    if (isSafeImageUrl(file.uri)) return file.uri.trim();
  }
  return undefined;
}

/**
 * Trimmed non-empty string, or undefined — DAS returns "" for absent fields.
 *
 * Truncation drops a trailing lone high surrogate: memecoin descriptions are
 * emoji-dense, and slicing mid-pair would leave an unpaired code unit that
 * renders as a replacement character.
 */
function text(value: unknown, max = MAX_DESCRIPTION): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Parse one DAS asset into HeliusSlotData. Pure and exported for tests — the
 * media/metadata fields below cost NO extra request: they arrive on the same
 * getAssetBatch response the age/authority signals already come from.
 */
export function parseDasAsset(asset: HeliusAsset): HeliusSlotData {
  const supply =
    asset.token_info?.supply ?? asset.supply?.print_current_supply ?? null;

  const imageUrl = pickDasImageUrl(asset.content);
  const description = text(asset.content?.metadata?.description);
  const tokenStandard = text(asset.content?.metadata?.token_standard, 64);
  const decimals = asset.token_info?.decimals;
  const updateAuthority = text(
    asset.authorities?.find(
      (a) => Array.isArray(a?.scopes) && a.scopes.includes("full")
    )?.address,
    64
  );
  const jsonUri = asset.content?.json_uri;

  return {
    slot: asset.slot ?? null,
    createdAt: asset.created_at ?? null,
    heliusName: asset.content?.metadata?.name ?? null,
    heliusSymbol: asset.content?.metadata?.symbol ?? null,
    tokenInterface: asset.interface ?? null,
    supply,
    // Rug-risk signals — only when DAS actually reported them (undefined = unknown)
    ...(asset.token_info
      ? {
          mintAuthorityActive: asset.token_info.mint_authority != null,
          freezeAuthorityActive: asset.token_info.freeze_authority != null,
        }
      : {}),
    ...(typeof asset.mutable === "boolean"
      ? { metadataMutable: asset.mutable }
      : {}),
    // Media + metadata. Each stays ABSENT when DAS did not report it, so a
    // consumer can tell "no description" from "never looked".
    ...(imageUrl ? { imageUrl } : {}),
    ...(description ? { description } : {}),
    ...(tokenStandard ? { tokenStandard } : {}),
    ...(typeof decimals === "number" &&
    Number.isFinite(decimals) &&
    decimals >= 0
      ? { decimals }
      : {}),
    ...(updateAuthority ? { updateAuthority } : {}),
    ...(typeof asset.burnt === "boolean" ? { burnt: asset.burnt } : {}),
    ...(isSafeImageUrl(jsonUri) ? { jsonUri: jsonUri.trim() } : {}),
  };
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

  // Cache hits return the WHOLE stored HeliusSlotData — media and metadata
  // included. (A past regression here served cache hits through a narrower
  // shape, silently nulling metadata on the second scan of a mint; the
  // "cache hit keeps the DAS media fields" test guards that.)
  const uncached: string[] = [];
  for (const mint of mints) {
    const cached = getHeliusMeta(mint);
    if (cached) {
      result.set(mint, cached);
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
      const data = parseDasAsset(asset);
      result.set(asset.id, data);
      setHeliusMeta(asset.id, data);
    }
  } catch {
    // Graceful fallback — tokens without data sort by other signals
  }

  return result;
}

// ————————————— Off-chain metadata JSON (socials for the scanned mint) —————————————

/**
 * Parse a mint's off-chain metadata JSON into socials + description. Pure and
 * exported for tests.
 *
 * Shape verified empirically 2026-08-11 across 53 reachable json_uri documents
 * from live Solana pairs: `website`, `twitter` and `telegram` appear at the top
 * level, and the SAME names appear under an `extensions` object (34 of 53 docs
 * carry one). Top level wins; `extensions` fills gaps; Metaplex's standard
 * `external_url` is the last website fallback.
 *
 * Every URL is attacker-controlled — each one goes through isSafeImageUrl, so a
 * `javascript:` "website" never reaches an href.
 */
export function parseOffchainTokenMeta(json: unknown): OffchainTokenMeta {
  const meta: OffchainTokenMeta = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return meta;

  const doc = json as Record<string, unknown>;
  const rawExt = doc.extensions;
  const ext: Record<string, unknown> =
    rawExt && typeof rawExt === "object" && !Array.isArray(rawExt)
      ? (rawExt as Record<string, unknown>)
      : {};

  const url = (...candidates: unknown[]): string | undefined => {
    for (const candidate of candidates) {
      if (isSafeImageUrl(candidate)) return candidate.trim();
    }
    return undefined;
  };

  const website = url(doc.website, ext.website, doc.external_url);
  const twitter = url(doc.twitter, ext.twitter);
  const telegram = url(doc.telegram, ext.telegram);
  const description = text(doc.description);

  if (website) meta.website = website;
  if (twitter) meta.twitter = twitter;
  if (telegram) meta.telegram = telegram;
  if (description) meta.description = description;
  return meta;
}

/**
 * Fetch + parse a mint's off-chain metadata JSON. ONE request, cached by URI,
 * short timeout — this runs for the scanned mint only, never per cohort token.
 *
 * Returns null when the URI is unusable/unsafe or the fetch failed. Failures
 * are cached briefly (not for the full TTL) so a flaky IPFS gateway costs one
 * request per few minutes instead of one per scan, without pinning "no socials"
 * on a token for an hour. Never throws.
 */
export async function getTokenOffchainMeta(
  jsonUri: string | undefined | null
): Promise<OffchainTokenMeta | null> {
  try {
    // Attacker-controlled URI fetched by OUR server: private address space is
    // excluded on top of the http/https check.
    if (!isSafeFetchUrl(jsonUri)) return null;
    const uri = jsonUri.trim();

    const cached = getOffchainMetaCache(uri);
    if (cached) return cached;

    const json = await fetchWithTimeout(uri, OFFCHAIN_META_TIMEOUT);
    const meta = parseOffchainTokenMeta(json);
    setOffchainMetaCache(uri, meta);
    return meta;
  } catch {
    // Cache the miss briefly so one dead gateway can't be re-dialed every scan.
    if (typeof jsonUri === "string") {
      try {
        setOffchainMetaCache(jsonUri.trim(), {}, OFFCHAIN_META_FAIL_TTL);
      } catch {
        // cache write failure is never worth failing a scan over
      }
    }
    return null;
  }
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
          parsed?: {
            type?: string;
            info?: {
              supply?: string;
              /** Base58 when active; omitted/null when revoked (COption::None). */
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
            };
          };
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
    // jsonParsed mint account carries authorities; metadata mutability stays unknown here
    ...(parsed.info
      ? {
          mintAuthorityActive: parsed.info.mintAuthority != null,
          freezeAuthorityActive: parsed.info.freezeAuthority != null,
        }
      : {}),
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

// ————————————————— Token-2022 extensions (honeypot machinery) —————————————————

/**
 * jsonParsed shape of one Token-2022 extension. VERIFIED against mainnet
 * (2026-08) — see parseMintExtensions for the per-extension evidence.
 */
interface ParsedExtension {
  extension?: string;
  state?: {
    /** transferHook: null when no hook program is installed (inert). */
    programId?: string | null;
    /** permanentDelegate */
    delegate?: string | null;
    /** defaultAccountState: "frozen" | "initialized" */
    accountState?: string | null;
    /** transferFeeConfig */
    newerTransferFee?: { transferFeeBasisPoints?: number };
    olderTransferFee?: { transferFeeBasisPoints?: number };
  } | null;
}

/** COption::None renders as null; the all-ones default pubkey means unset too. */
const UNSET_PUBKEY = "11111111111111111111111111111111";

function realAddress(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v !== UNSET_PUBKEY ? v : null;
}

/**
 * Parse getAccountInfo(jsonParsed) into the extension facts the safety engine
 * needs. Exported for unit tests. Returns null when the response is not a
 * readable token mint — null always means UNKNOWN, never "no extensions".
 *
 * Shapes verified live on mainnet 2026-08:
 *   transferHook       {"state":{"authority":"..","programId":null}}  (PYUSD, PUMP)
 *                      programId "tHookmPkFZDJGkS9us6sVsnYi2EKHCrVtw8zD6oXYPE"
 *                      on 12AR5yihid9wxUHDf5xKqLpPkRX4nyaSKiAD7LXmLBu
 *   permanentDelegate  {"state":{"delegate":"2apBGMsS.."}}            (PYUSD)
 *   transferFeeConfig  {"state":{"newerTransferFee":{"transferFeeBasisPoints":20},..}}
 *   defaultAccountState{"state":{"accountState":"frozen"}}
 *                      on 15YGYD1afQzrdjuzJBDonV7U5yPyBJs7qT5MQBLP49b
 *   nonTransferable    NOT observed live (such tokens cannot trade on a DEX);
 *                      parsed defensively off the extension NAME alone, which
 *                      holds whether or not the parser emits a state object.
 */
export function parseMintExtensions(
  response: unknown
): MintExtensionFacts | null {
  const r = response as {
    result?: {
      value?: null | {
        owner?: string;
        data?: {
          parsed?: {
            type?: string;
            info?: {
              mintAuthority?: string | null;
              freezeAuthority?: string | null;
              extensions?: unknown;
            };
          };
        };
      };
    };
    error?: unknown;
  };
  if (r?.error) return null;

  const value = r?.result?.value;
  if (!value || typeof value !== "object") return null;

  const owner = value.owner;
  const isToken2022 = owner === SPL_TOKEN_2022_PROGRAM;
  if (owner !== SPL_TOKEN_PROGRAM && !isToken2022) return null;

  const parsed = value.data?.parsed;
  if (parsed?.type !== "mint") return null;
  const info = parsed.info;

  const facts: MintExtensionFacts = {
    hasTransferHook: false,
    nonTransferable: false,
    defaultAccountFrozen: false,
    permanentDelegate: null,
    transferFeeBps: null,
    isToken2022,
  };
  if (info) {
    facts.mintAuthorityActive = realAddress(info.mintAuthority) !== null;
    facts.freezeAuthorityActive = realAddress(info.freezeAuthority) !== null;
  }

  // A legacy SPL mint has no extensions — a successful read, zero findings.
  const list = info?.extensions;
  if (!Array.isArray(list)) return facts;

  for (const raw of list) {
    const e = raw as ParsedExtension;
    const state = e?.state ?? undefined;
    switch (e?.extension) {
      case "transferHook":
        // Only a REAL hook program can revert a sell; a null hook is inert.
        if (realAddress(state?.programId)) facts.hasTransferHook = true;
        break;
      case "nonTransferable":
      case "nonTransferableAccount":
        facts.nonTransferable = true;
        break;
      case "defaultAccountState":
        if (state?.accountState === "frozen") facts.defaultAccountFrozen = true;
        break;
      case "permanentDelegate": {
        const delegate = realAddress(state?.delegate);
        if (delegate) facts.permanentDelegate = delegate;
        break;
      }
      case "transferFeeConfig": {
        const bps =
          state?.newerTransferFee?.transferFeeBasisPoints ??
          state?.olderTransferFee?.transferFeeBasisPoints;
        if (typeof bps === "number" && Number.isFinite(bps)) {
          facts.transferFeeBps = bps;
        }
        break;
      }
      default:
        break;
    }
  }

  return facts;
}

/**
 * Read a mint's Token-2022 extensions (plus its live authorities, which come
 * in the same account read for free). Cached — extensions change rarely.
 *
 * Returns null on ANY failure, which the safety engine reads as "check did not
 * run" → unknown. It must never be read as "no dangerous extensions".
 */
export async function getMintExtensions(
  mint: string
): Promise<MintExtensionFacts | null> {
  try {
    const cached = getMintExtensionsCache(mint);
    if (cached) return cached;

    const params = [mint, { encoding: "jsonParsed" }];
    const urls = [
      getStandardJsonRpcUrl(),
      PUBLIC_MAINNET_RPC,
      process.env.SOLANA_RPC_URL?.trim(),
    ].filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);

    for (const url of urls) {
      try {
        const response = await jsonRpc(url, "getAccountInfo", params);
        const facts = parseMintExtensions(response);
        if (facts) {
          setMintExtensionsCache(mint, facts);
          return facts;
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure math behind getTopHolderShare — exported for unit tests. `amounts` are
 * raw token amounts in descending order (as getTokenLargestAccounts returns
 * them); non-finite/negative entries are dropped. Percentages are clamped to
 * 100 because raw supplies above 2^53 lose precision in Number().
 */
export function computeHolderShare(
  amounts: number[],
  supply: number
): { topTenPct: number; largestPct: number } | null {
  if (!Number.isFinite(supply) || supply <= 0) return null;
  const valid = amounts.filter((a) => Number.isFinite(a) && a >= 0);
  if (valid.length === 0) return null;
  const topTen = valid.slice(0, 10).reduce((sum, a) => sum + a, 0);
  return {
    topTenPct: Math.min(100, (100 * topTen) / supply),
    largestPct: Math.min(100, (100 * valid[0]) / supply),
  };
}

/**
 * Share of supply in the largest token accounts via getTokenLargestAccounts.
 * Includes LP pools and burn addresses — an UPPER BOUND on wallet
 * concentration. Falls back to getTokenSupply when the caller has no DAS
 * supply. Any failure returns null.
 */
export async function getTopHolderShare(
  mint: string,
  supplyRaw: number | null
): Promise<{ topTenPct: number; largestPct: number } | null> {
  try {
    const response = (await standardRpc("getTokenLargestAccounts", [
      mint,
      { commitment: "confirmed" },
    ])) as {
      result?: {
        value?: {
          address: string;
          amount: string;
          decimals: number;
          uiAmount: number | null;
        }[];
      };
    };
    const accounts = response?.result?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    let supply =
      supplyRaw != null && Number.isFinite(supplyRaw) && supplyRaw > 0
        ? supplyRaw
        : null;
    if (supply == null) {
      const supplyResponse = (await standardRpc("getTokenSupply", [mint])) as {
        result?: { value?: { amount?: string } };
      };
      const amount = supplyResponse?.result?.value?.amount;
      const parsed = amount != null && amount !== "" ? Number(amount) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) supply = parsed;
    }
    if (supply == null) return null;

    return computeHolderShare(
      accounts.map((a) => Number(a?.amount)),
      supply
    );
  } catch {
    return null;
  }
}

/** Where a previous walk stopped, so a deeper attempt continues from there. */
export interface WalkResumePoint {
  /** Signature to pass as `before` — the deepest one already seen. */
  signature: string;
  /** Its slot/blockTime, so an immediately-empty next page still yields an answer. */
  slot?: number;
  blockTime?: number;
  /** Pages already spent on this address across previous attempts. */
  pagesWalked?: number;
}

export interface WalkOutcome {
  oldest: SignatureResult;
  /** True = the oldest page was still full — the result is only a LOWER BOUND. */
  truncated: boolean;
  /** Cumulative pages spent on this address (resumed pages included). */
  pagesWalked: number;
}

/**
 * Backward-paginate getSignaturesForAddress toward the address's very first
 * transaction. limit:1000 per page, up to `maxPages` pages THIS call.
 *
 * truncated=true means the walk stopped with a full page still behind it (page
 * budget or deadline) — the result is a lower bound, and `oldest.signature` is
 * the resume point for a later, deeper attempt.
 *
 * `resume` continues a previous walk. Its slot/blockTime seed the answer, which
 * matters in the exact case where the resumed page comes back EMPTY: that means
 * the resume signature WAS the first transaction, so the walk is complete.
 *
 * `deadlineMs` (absolute epoch ms) is checked before each additional page, so a
 * slow address stops on time instead of pinning a request open.
 *
 * Exported for tests. Throws on RPC failure (callers wrap).
 */
export async function walkToOldestSignature(
  address: string,
  opts?: {
    maxPages?: number;
    resume?: WalkResumePoint;
    deadlineMs?: number;
  }
): Promise<WalkOutcome | null> {
  const maxPages = Math.max(1, Math.floor(opts?.maxPages ?? MAX_SIG_PAGES));
  const resume = opts?.resume;
  const deadlineMs = opts?.deadlineMs;

  let before: string | undefined = resume?.signature;
  // Seed from the resume point only when it carries a usable timestamp.
  let oldestSig: SignatureResult | null =
    resume?.signature != null &&
    typeof resume.slot === "number" &&
    typeof resume.blockTime === "number"
      ? {
          slot: resume.slot,
          blockTime: resume.blockTime,
          signature: resume.signature,
        }
      : null;
  // A resumed walk starts truncated: we know a full page sat behind the seed.
  let truncated = resume?.signature != null;
  const priorPages = Math.max(0, Math.floor(resume?.pagesWalked ?? 0));
  let pages = 0;

  for (let page = 0; page < maxPages; page++) {
    // Out of time: stop with whatever we have, still flagged as a lower bound.
    if (page > 0 && deadlineMs !== undefined && Date.now() >= deadlineMs) break;

    const params: [string, { limit: number; before?: string }] = [
      address,
      { limit: 1000 },
    ];
    if (before) params[1].before = before;

    const response = (await standardRpc(
      "getSignaturesForAddress",
      params
    )) as { result?: SignatureResult[] };
    pages++;

    const sigs = response?.result;
    if (!Array.isArray(sigs) || sigs.length === 0) {
      // Nothing older than `before` exists — `before` is the first transaction.
      truncated = false;
      break;
    }

    oldestSig = sigs[sigs.length - 1];
    before = oldestSig.signature;

    // If fewer than 1000 results, we've reached the beginning
    if (sigs.length < 1000) {
      truncated = false;
      break;
    }

    // Full page: if we run out of pages here, oldest time is only a lower bound
    truncated = true;
  }

  if (!oldestSig) return null;
  return { oldest: oldestSig, truncated, pagesWalked: priorPages + pages };
}

export interface CreationSlotResult {
  slot: number;
  blockTime: number;
  /** True = walk incomplete; the true creation time is AT OR BEFORE blockTime. */
  truncated: boolean;
  /** Oldest signature reached — the resume point when truncated. */
  signature?: string;
  /** Cumulative pages spent on this address, including resumed ones. */
  pagesWalked?: number;
}

/**
 * Get the actual creation slot/blockTime for a mint by paginating backward
 * through getSignaturesForAddress until we find the very first transaction.
 *
 * Default budget is the cheap MAX_SIG_PAGES (bulk cohort dating). Callers that
 * have decided a token's age is worth resolving pass a bigger `maxPages`
 * (DEEP_SIG_PAGES); that path also RESUMES from any persisted progress rather
 * than re-walking pages a previous attempt already paid for.
 *
 * Completed walks are cached (L1) and persisted as verified facts (L2).
 * Incomplete walks are persisted as PROGRESS ONLY (verified_complete = 0) —
 * never cached, never served as a date, but readable so the next deep attempt
 * picks up where this one stopped.
 */
export async function getCreationSlot(
  mint: string,
  opts?: {
    maxPages?: number;
    /** Explicit resume signature; otherwise persisted progress is used. */
    resumeFrom?: string;
    /** Absolute epoch-ms ceiling for this walk. */
    deadlineMs?: number;
  }
): Promise<CreationSlotResult | null> {
  const cached = getCreationSlotCache(mint);
  if (cached) return { ...cached, truncated: false };

  const maxPages = opts?.maxPages ?? MAX_SIG_PAGES;

  try {
    // Resume: an explicit signature wins; otherwise reuse persisted progress.
    // A cheap default-budget pass does NOT resume — the deep phase owns that
    // decision, and a 5-page walk from a deep resume point would spend the
    // bulk budget chasing one token.
    let resume: WalkResumePoint | undefined;
    const wantsResume = opts?.resumeFrom != null || maxPages > MAX_SIG_PAGES;
    // Lazy: the bulk pass runs this for every token in a cohort, so it must not
    // pay a SQLite read it has no use for.
    const progress = wantsResume ? getCreationWalkProgress(mint) : undefined;
    if (opts?.resumeFrom) {
      resume = {
        signature: opts.resumeFrom,
        ...(progress &&
        !progress.verifiedComplete &&
        progress.deepestSig === opts.resumeFrom
          ? {
              slot: progress.slot,
              blockTime: progress.blockTime,
              pagesWalked: progress.pagesWalked ?? undefined,
            }
          : {}),
      };
    } else if (
      maxPages > MAX_SIG_PAGES &&
      progress &&
      !progress.verifiedComplete &&
      progress.deepestSig
    ) {
      resume = {
        signature: progress.deepestSig,
        slot: progress.slot,
        blockTime: progress.blockTime,
        pagesWalked: progress.pagesWalked ?? undefined,
      };
    }

    const found = await walkToOldestSignature(mint, {
      maxPages,
      ...(resume ? { resume } : {}),
      ...(opts?.deadlineMs !== undefined
        ? { deadlineMs: opts.deadlineMs }
        : {}),
    });
    if (!found) return null;

    const data = {
      slot: found.oldest.slot,
      blockTime: found.oldest.blockTime,
      signature: found.oldest.signature,
      pagesWalked: found.pagesWalked,
    };
    // Only cache complete scans with real blockTimes — truncated results are a
    // lower bound, so leave them uncached for a later deeper look to retry.
    if (!found.truncated && data.blockTime > 0) {
      setCreationSlotCache(mint, data);
    } else if (found.truncated && data.blockTime > 0) {
      // Persist the resume point so the next deep attempt continues instead of
      // re-walking. verified_complete stays 0 — this is not an answer.
      setCreationWalkProgress(mint, {
        slot: data.slot,
        blockTime: data.blockTime,
        deepestSig: data.signature,
        pagesWalked: found.pagesWalked,
      });
    }
    return { ...data, truncated: found.truncated };
  } catch {
    return null;
  }
}

// ————————————————————— Deployer intelligence —————————————————————

/**
 * Resolve the wallet that deployed a mint: fee payer (accountKeys[0]) of the
 * mint's very first transaction. Persisted in creation_slots.deployer so
 * repeats are free. Truncated history (mint older than MAX_SIG_PAGES pages) or
 * any RPC failure → null. Never throws.
 */
export async function getDeployer(mint: string): Promise<string | null> {
  const persisted = getDeployerPersisted(mint);
  if (persisted) return persisted;

  try {
    // The scan pipeline has usually just run getCreationSlot(mint) — the L1
    // hit carries the oldest signature for free. L2-only hits (post-restart)
    // lack the signature and re-run the bounded pagination once.
    const cs = await getCreationSlot(mint);
    if (!cs || cs.truncated) return null;

    let sig = cs.signature;
    let slot = cs.slot;
    let blockTime = cs.blockTime;
    if (!sig) {
      const found = await walkToOldestSignature(mint);
      if (!found || found.truncated) return null;
      sig = found.oldest.signature;
      slot = found.oldest.slot;
      blockTime = found.oldest.blockTime;
    }

    const response = (await standardRpc("getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ])) as {
      result?: {
        transaction?: {
          message?: {
            accountKeys?: ({ pubkey?: string } | string)[];
          };
        };
      };
    };
    const first = response?.result?.transaction?.message?.accountKeys?.[0];
    const deployer =
      typeof first === "string" ? first : first?.pubkey ?? null;
    if (!deployer || typeof deployer !== "string") return null;

    setDeployerPersisted(mint, deployer, { slot, blockTime });
    return deployer;
  } catch {
    return null;
  }
}

/** Deployer profiles are refreshed after 24h — wallets keep launching tokens. */
export const DEPLOYER_PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;

/** True while a persisted deployer profile is inside the freshness window. */
export function isDeployerProfileFresh(
  checkedAt: number,
  now = Date.now()
): boolean {
  return now - checkedAt < DEPLOYER_PROFILE_FRESH_MS;
}

export interface DeployerProfile {
  /**
   * Helius-parsed CREATE (token launch, e.g. pump.fun) transactions by this
   * wallet, capped at TOKENS_CREATED_CAP. null = count unavailable.
   * NOT DAS searchAssets(creatorAddress): pump.fun mints carry an empty
   * on-chain creators array, so that query returns 0 for exactly the wallets
   * we care about (verified empirically 2026-08).
   */
  tokensCreated: number | null;
  /** blockTime of the wallet's first transaction (ms). null = unknown or too deep. */
  walletFirstSeenMs: number | null;
  /** History deeper than MAX_SIG_PAGES pages — an established wallet, not a fresh one. */
  isOldWallet: boolean;
  checkedAt: number;
}

/**
 * Count token-launch transactions via the Helius Enhanced Transactions API
 * (type=CREATE — pump.fun launches are CREATE/PUMP_FUN). One page, capped.
 * Throws on fetch failure (caller maps to null).
 */
async function countDeployerCreates(deployer: string): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return null;
  const url =
    `https://api.helius.xyz/v0/addresses/${encodeURIComponent(deployer)}` +
    `/transactions?api-key=${encodeURIComponent(key)}` +
    `&type=CREATE&limit=${TOKENS_CREATED_CAP}`;
  const res = await fetchWithTimeout(url, HELIUS_TIMEOUT);
  if (!Array.isArray(res)) return null;
  return Math.min(res.length, TOKENS_CREATED_CAP);
}

/**
 * Profile a deployer wallet: launch count + wallet age. Served from the
 * deployer_profiles table while fresh (<24h); refreshed on expiry. A profile
 * with no signal at all (both lookups failed) is returned but never persisted,
 * so a transient outage can't pin nulls for 24h. Never throws.
 */
export async function getDeployerProfile(
  deployer: string
): Promise<DeployerProfile | null> {
  try {
    const cached = getDeployerProfilePersisted(deployer);
    if (cached && isDeployerProfileFresh(cached.checkedAt)) return cached;

    let tokensCreated: number | null = null;
    try {
      tokensCreated = await countDeployerCreates(deployer);
    } catch {
      tokensCreated = null;
    }

    // Wallet age via the same first-transaction machinery mints use —
    // truncated pagination means deep history: old wallet, exact date unknown.
    let walletFirstSeenMs: number | null = null;
    let isOldWallet = false;
    const cs = await getCreationSlot(deployer);
    if (cs) {
      if (cs.truncated) {
        isOldWallet = true;
      } else if (cs.blockTime > 0) {
        walletFirstSeenMs = cs.blockTime * 1000;
      }
    }

    const profile: DeployerProfile = {
      tokensCreated,
      walletFirstSeenMs,
      isOldWallet,
      checkedAt: Date.now(),
    };
    if (tokensCreated != null || walletFirstSeenMs != null || isOldWallet) {
      setDeployerProfilePersisted(deployer, profile);
    }
    return profile;
  } catch {
    return null;
  }
}
