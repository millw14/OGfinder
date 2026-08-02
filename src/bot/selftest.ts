/**
 * Offline smoke test for the bot's pure logic — no network, no Telegram.
 * Run: npm run bot:selftest
 */
import {
  base58Decode,
  isValidSolanaAddress,
  detectAddresses,
} from "./detect";
import {
  escapeHtml,
  fmtUsd,
  fmtPct,
  formatAgeGap,
  truncateMint,
  buildShareUrl,
  verdictMessage,
} from "./format";
import { BotStore } from "./store";
import { decodeSharePayload } from "../lib/share";
import { ScanVerdict } from "../lib/scan-core";
import { TokenResult } from "../lib/types";

let failures = 0;
let passed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
  } else {
    failures++;
    console.error(`✗ ${name}${detail !== undefined ? ` — got: ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── base58 / address validation ───────────────────────────────────
{
  const zeros = base58Decode("11111111111111111111111111111111");
  check("base58: system program decodes to 32 zero bytes",
    zeros !== null && zeros.length === 32 && zeros.every((b) => b === 0));

  check("address: wSOL mint is valid",
    isValidSolanaAddress("So11111111111111111111111111111111111111112"));
  check("address: USDC mint is valid",
    isValidSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  check("address: junk word is invalid", !isValidSolanaAddress("hello world"));
  check("address: 0/O chars are invalid",
    !isValidSolanaAddress("0OIl000000000000000000000000000000000000"));
  check("address: too-short base58 is invalid", !isValidSolanaAddress("abc"));
}

// ── CA detection in chat text ─────────────────────────────────────
{
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const wsol = "So11111111111111111111111111111111111111112";

  const d1 = detectAddresses(`yo check this ${usdc} now`);
  check("detect: raw CA in sentence", d1.mints.length === 1 && d1.mints[0] === usdc, d1);

  const d2 = detectAddresses("nothing to see here, just words");
  check("detect: plain text finds nothing", d2.mints.length === 0 && d2.pairAddresses.length === 0);

  const d3 = detectAddresses(
    "11111111111111111111111111111111 and TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );
  check("detect: program ids are filtered out", d3.mints.length === 0, d3.mints);

  const d4 = detectAddresses(`https://pump.fun/coin/${usdc}`);
  check("detect: pump.fun link", d4.mints[0] === usdc, d4);

  const d5 = detectAddresses(`https://solscan.io/token/${usdc}`);
  check("detect: solscan link", d5.mints[0] === usdc, d5);

  const d6 = detectAddresses(`https://dexscreener.com/solana/${wsol}`);
  check(
    "detect: dexscreener link goes to pair bucket (needs resolution)",
    d6.pairAddresses.length === 1 && d6.pairAddresses[0] === wsol && d6.mints.length === 0,
    d6
  );

  const d7 = detectAddresses(`https://neo.bullx.io/terminal?chainId=1399811149&address=${usdc}`);
  check("detect: bullx query-param link", d7.mints[0] === usdc, d7);

  const d8 = detectAddresses(`${usdc} ${usdc} ${wsol}`);
  check("detect: dedupe + multiple", d8.mints.length === 2, d8.mints);

  // A base58 run longer than 44 chars must NOT yield an embedded match.
  const embedded = `1${usdc}1`;
  const d9 = detectAddresses(embedded);
  check("detect: no partial match inside longer base58 run", d9.mints.length === 0, d9.mints);
}

// ── formatting ────────────────────────────────────────────────────
{
  check("fmtUsd: millions", fmtUsd(1_234_567) === "$1.2M", fmtUsd(1_234_567));
  check("fmtUsd: thousands", fmtUsd(3_400) === "$3.4K", fmtUsd(3_400));
  check("fmtUsd: dollars", fmtUsd(1.239) === "$1.24", fmtUsd(1.239));
  check("fmtUsd: sub-cent keeps 2 sig digits", fmtUsd(0.00423) === "$0.0042", fmtUsd(0.00423));
  check("fmtUsd: tiny price expands (no exponent)", fmtUsd(1.2e-10) === "$0.00000000012", fmtUsd(1.2e-10));
  check("fmtUsd: micro price stays decimal", fmtUsd(0.0000012) === "$0.0000012", fmtUsd(0.0000012));
  check("fmtUsd: null passthrough", fmtUsd(null) === null);
  check("fmtPct: positive gets sign", fmtPct(12.34) === "+12.3%", fmtPct(12.34));
  check("fmtPct: negative", fmtPct(-8) === "-8.0%", fmtPct(-8));
  check("ageGap: days", formatAgeGap(12 * 86400000) === "12 days");
  check("ageGap: months", formatAgeGap(65 * 86400000) === "2mo");
  check("ageGap: years+months", formatAgeGap(400 * 86400000) === "1y 1mo", formatAgeGap(400 * 86400000));
  check("escapeHtml", escapeHtml(`<b>&"</b>`) === "&lt;b&gt;&amp;\"&lt;/b&gt;", escapeHtml(`<b>&"</b>`));
  check("truncateMint", truncateMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") === "EPjFWd…yTDt1v", truncateMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
}

// ── verdict card + share URL round-trip ───────────────────────────
{
  const og: TokenResult = {
    mint: "OGmint111111111111111111111111111111111111",
    displayName: "Doge",
    displaySymbol: "DOGE",
    slot: 1,
    createdAtMs: Date.UTC(2022, 11, 20),
    createdAt: new Date(Date.UTC(2022, 11, 20)).toISOString(),
    dexId: "raydium",
    confidence: 5,
    confidenceLabel: "OG",
    rank: 1,
    rankLabel: "OG",
    timeSource: "helius",
    priceUsd: 0.002,
    marketCapUsd: 1_200_000,
    liquidityUsd: 340_000,
    priceChange24h: 12.3,
  };
  const scanned: TokenResult = {
    ...og,
    mint: "CopyMint11111111111111111111111111111111111",
    createdAtMs: Date.UTC(2025, 6, 2),
    createdAt: new Date(Date.UTC(2025, 6, 2)).toISOString(),
    rank: 14,
    rankLabel: "Newer",
    confidence: 1,
    confidenceLabel: "Low confidence",
    isScanned: true,
  };
  const v: ScanVerdict = {
    scannedMint: scanned.mint,
    results: [og, scanned],
    query: "doge",
    scanName: "Doge",
    scanSymbol: "DOGE",
    scanned,
    isScannedOG: false,
    scannedRank: 14,
    totalFound: 87,
  };

  const url = buildShareUrl("https://example.org", v);
  const vParam = new URL(url).searchParams.get("v") ?? "";
  const decoded = decodeSharePayload(vParam);
  check("share URL round-trips through the site decoder",
    decoded !== null &&
      decoded.n === "Doge" &&
      decoded.o === false &&
      decoded.r === 14 &&
      decoded.t === 87 &&
      decoded.m === scanned.mint,
    decoded);

  const card = verdictMessage(v, "https://example.org");
  check("verdict card: NOT-OG headline", card.text.includes("NOT THE OG"));
  check("verdict card: rank line", card.text.includes("#14 of 87 by age"));
  check("verdict card: OG comparison shown", card.text.includes("The OG"));
  check("verdict card: OG mint present", card.text.includes(og.mint));
  check("verdict card: has buttons", card.keyboard.length > 0);

  const vOg: ScanVerdict = {
    ...v,
    scannedMint: og.mint,
    scanned: og,
    isScannedOG: true,
    scannedRank: 1,
  };
  const cardOg = verdictMessage(vOg, null);
  check("verdict card: OG headline", cardOg.text.includes("THIS IS THE OG"));
  check("verdict card: no site button without SITE_URL",
    cardOg.keyboard.every((row) => row.every((b) => !b.url || !b.url.includes("example.org"))));
}

// ── store (in-memory sqlite) ──────────────────────────────────────
{
  const store = new BotStore(":memory:");

  const s0 = store.getChatSettings(-100123);
  check("store: default settings", s0.autoscan === true && s0.quiet === false);

  const s1 = store.setChatSetting(-100123, "quiet", true);
  check("store: quiet toggled", s1.quiet === true && s1.autoscan === true);
  check("store: settings persist", store.getChatSettings(-100123).quiet === true);

  const mintA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  check("store: watch added", store.addWatch(-1, mintA, "USDC", 42, 1, 1000) === "added");
  check("store: watch exists", store.addWatch(-1, mintA, "USDC", 42, 1, 1000) === "exists");
  for (let i = 0; i < 9; i++) {
    store.addWatch(-1, `${mintA.slice(0, 43)}${"abcdefghi"[i]}`, null, 42, null, null);
  }
  check("store: cap enforced at 10",
    store.addWatch(-1, "So11111111111111111111111111111111111111112", null, 42, null, null) === "full");
  check("store: watchlist size", store.listWatches(-1).length === 10);
  check("store: unwatch", store.removeWatch(-1, mintA) === true);

  store.recordScan(-5, mintA, "USDC", true, 1, 3);
  store.recordScan(-5, mintA, "USDC", true, 1, 3);
  store.recordScan(-5, "So11111111111111111111111111111111111111112", "wSOL", false, 2, 9);
  const stats = store.chatStats(-5);
  check("store: stats totals", stats.scans === 3 && stats.ogCount === 2, stats);
  check("store: stats top mint", stats.topMints[0]?.mint === mintA, stats.topMints);

  store.migrateChat(-5, -100999);
  check("store: migration moves scans", store.chatStats(-100999).scans === 3);
  check("store: old chat emptied", store.chatStats(-5).scans === 0);

  store.close();
}

console.log(`\n[bot:selftest] ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
