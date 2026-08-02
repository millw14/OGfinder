import { TokenResult, WalletAnalysis } from "../lib/types";
import { ScanVerdict } from "../lib/scan-core";
import { timeAgo } from "../lib/format";
import { formatShareDate, encodeSharePayload, SharePayload } from "../lib/share";
import { bucketForToken, labelForBucket } from "../lib/launchpads";
import { TgInlineKeyboard } from "./bot-types";

/** Telegram HTML output helpers + verdict/list/compare message builders. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncateMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return `${mint.slice(0, 6)}…${mint.slice(-6)}`;
}

/** $1.23 / $0.0000042 / $1.2K / $3.4M / $1.1B */
export function fmtUsd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  // Sub-dollar: 2 significant digits. toPrecision uses exponent notation
  // below 1e-6 — expand those back to plain decimals for chat display.
  if (n >= 1e-6) return `$${n.toPrecision(2)}`;
  const rounded = Number(n.toPrecision(2));
  return `$${rounded.toFixed(15).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function fmtPct(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/** Age gap between the OG and the scanned mint: "2y 3mo" / "8mo" / "12 days". */
export function formatAgeGap(gapMs: number): string {
  const days = Math.floor(gapMs / 86400000);
  if (days < 1) return "less than a day";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years}y` : `${years}y ${rem}mo`;
}

function mintedLine(t: TokenResult | undefined | null): string {
  if (!t) return "unknown age";
  const date = formatShareDate(t.createdAt) ?? "unknown date";
  const ago = timeAgo(t.createdAt);
  const bound = t.createdAtIsLowerBound ? " · may be older" : "";
  return `${date}${ago ? ` (${ago})` : ""}${bound}`;
}

function marketLine(t: TokenResult | undefined | null): string | null {
  if (!t) return null;
  const parts: string[] = [];
  const venue = labelForBucket(bucketForToken(t.dexId, t.mint));
  if (venue && venue !== "No DEX / Jupiter only") parts.push(`🚀 ${venue}`);
  const price = fmtUsd(t.priceUsd);
  if (price) parts.push(`💰 ${price}`);
  const mc = fmtUsd(t.marketCapUsd ?? t.fdvUsd);
  if (mc) parts.push(`MC ${mc}`);
  const liq = fmtUsd(t.liquidityUsd);
  if (liq) parts.push(`Liq ${liq}`);
  const chg = fmtPct(t.priceChange24h);
  if (chg) parts.push(`24h ${chg}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function tokenLabel(name: string | null, symbol: string | null): string {
  const n = escapeHtml(name ?? "Unknown token");
  const s = symbol ? ` ($${escapeHtml(symbol)})` : "";
  return `<b>${n}</b>${s}`;
}

/** Same share URL the site's "Share verdict" button copies. */
export function buildShareUrl(
  siteUrl: string,
  v: ScanVerdict
): string {
  const payload: SharePayload = {
    n: v.scanName ?? v.scanned?.displayName ?? "Unknown",
    s: v.scanSymbol ?? v.scanned?.displaySymbol ?? "",
    d: v.scanned?.createdAt ?? null,
    r: v.scannedRank,
    t: v.totalFound,
    o: v.isScannedOG,
    m: v.scannedMint,
  };
  return `${siteUrl}/?q=${encodeURIComponent(
    v.scannedMint
  )}&v=${encodeSharePayload(payload)}`;
}

export interface VerdictMessage {
  text: string;
  keyboard: TgInlineKeyboard;
}

/**
 * The group-chat verdict card — same data the site's ScanHero shows:
 * verdict, rank of total, minted date/age, market data, and (when not OG)
 * a comparison against the actual #1 by age.
 */
export function verdictMessage(
  v: ScanVerdict,
  siteUrl: string | null
): VerdictMessage {
  const lines: string[] = [];
  const scanned = v.scanned;
  const og = v.results.length > 0 ? v.results[0] : null;
  const label = tokenLabel(
    v.scanName ?? scanned?.displayName ?? null,
    v.scanSymbol ?? scanned?.displaySymbol ?? null
  );

  if (v.scannedRank == null) {
    lines.push(`🔬 <b>CONTRACT SCAN</b> — ${label}`);
    lines.push("");
    lines.push(
      "Resolved on-chain, but this mint didn't appear in the ranked results — try a name search."
    );
    lines.push(`🪙 <code>${escapeHtml(v.scannedMint)}</code>`);
  } else if (v.isScannedOG) {
    lines.push(`🏆 <b>THIS IS THE OG</b> — ${label}`);
    lines.push(`Oldest of ${v.totalFound} matching token${v.totalFound === 1 ? "" : "s"}`);
    lines.push("");
    lines.push(`🗓 Minted ${mintedLine(scanned)}`);
    const market = marketLine(scanned);
    if (market) lines.push(market);
    lines.push(`🪙 <code>${escapeHtml(v.scannedMint)}</code>`);
  } else {
    lines.push(`❌ <b>NOT THE OG</b> — ${label}`);
    const gapMs =
      og?.createdAtMs != null && scanned?.createdAtMs != null
        ? scanned.createdAtMs - og.createdAtMs
        : null;
    const gap =
      gapMs != null && gapMs > 0 ? ` · OG is older by ${formatAgeGap(gapMs)}` : "";
    lines.push(`#${v.scannedRank} of ${v.totalFound} by age${gap}`);
    lines.push("");
    lines.push(`🗓 Minted ${mintedLine(scanned)}`);
    const market = marketLine(scanned);
    if (market) lines.push(market);
    lines.push(`🪙 <code>${escapeHtml(v.scannedMint)}</code>`);

    if (og && og.mint !== v.scannedMint) {
      lines.push("");
      lines.push(
        `👑 <b>The OG</b> — ${tokenLabel(og.displayName, og.displaySymbol)}`
      );
      lines.push(`🗓 Minted ${mintedLine(og)}`);
      const ogMarket = marketLine(og);
      if (ogMarket) lines.push(ogMarket);
      lines.push(`🪙 <code>${escapeHtml(og.mint)}</code>`);
    }
  }

  const warnings: string[] = [];
  if (scanned?.supplyZero) {
    warnings.push("⚠️ Scanned token's supply is fully burned");
  }
  if (
    !v.isScannedOG &&
    scanned?.createdAtMs != null &&
    og?.createdAtMs != null
  ) {
    const scannedAgeMs = Date.now() - scanned.createdAtMs;
    const gapMs = scanned.createdAtMs - og.createdAtMs;
    if (scannedAgeMs < 7 * 86400000 && gapMs > 30 * 86400000) {
      warnings.push("⚠️ Fresh mint reusing a much older token's name — possible copycat");
    }
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  const keyboard: TgInlineKeyboard = [];
  const row1 = [];
  if (siteUrl) {
    row1.push({ text: "🌐 View on OGfinder", url: buildShareUrl(siteUrl, v) });
  }
  row1.push({
    text: "📈 Chart",
    url: `https://dexscreener.com/solana/${v.scannedMint}`,
  });
  keyboard.push(row1);

  const row2 = [];
  if (v.totalFound > 1) {
    row2.push({ text: "👑 Top 5 oldest", callback_data: `t5:${v.scannedMint}` });
  }
  if (!v.isScannedOG && og && og.mint !== v.scannedMint) {
    row2.push({ text: "🔎 Scan the OG", callback_data: `scan:${og.mint}` });
  }
  if (row2.length > 0) keyboard.push(row2);

  return { text: lines.join("\n"), keyboard };
}

/** Ranked oldest-first list for name searches and the "Top 5" button. */
export function topListMessage(
  results: TokenResult[],
  queryLabel: string,
  totalFound: number,
  limit: number,
  siteUrl: string | null,
  highlightMint?: string
): VerdictMessage {
  const lines: string[] = [];
  lines.push(
    `👑 <b>Oldest "${escapeHtml(queryLabel)}" tokens</b> (${totalFound} found)`
  );
  lines.push("");

  const medals = ["🥇", "🥈", "🥉"];
  const top = results.slice(0, limit);
  top.forEach((t, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const you = highlightMint && t.mint === highlightMint ? " ← scanned" : "";
    const venue = labelForBucket(bucketForToken(t.dexId, t.mint));
    const venuePart =
      venue && venue !== "No DEX / Jupiter only" ? ` · ${venue}` : "";
    lines.push(
      `${medal} ${tokenLabel(t.displayName, t.displaySymbol)} — ${mintedLine(t)}${venuePart}${you}`
    );
    lines.push(`      <code>${escapeHtml(t.mint)}</code>`);
  });

  if (totalFound > limit) {
    lines.push("");
    lines.push(`…and ${totalFound - limit} more, ranked by on-chain age.`);
  }

  const keyboard: TgInlineKeyboard = [];
  if (siteUrl) {
    keyboard.push([
      {
        text: "🌐 Full list on OGfinder",
        url: `${siteUrl}/?q=${encodeURIComponent(queryLabel)}`,
      },
    ]);
  }
  return { text: lines.join("\n"), keyboard };
}

/** One-token card for inline mode — rank-aware (no fake medals). */
export function inlineTokenCard(
  t: TokenResult,
  queryLabel: string,
  totalFound: number,
  siteUrl: string | null
): VerdictMessage {
  const rankTag =
    t.rank === 1 ? "👑 The OG" : `#${t.rank} of ${totalFound} by age`;
  const lines = [
    `${rankTag} — ${tokenLabel(t.displayName, t.displaySymbol)} for "${escapeHtml(queryLabel)}"`,
    `🗓 Minted ${mintedLine(t)}`,
  ];
  const market = marketLine(t);
  if (market) lines.push(market);
  lines.push(`🪙 <code>${escapeHtml(t.mint)}</code>`);

  const keyboard: TgInlineKeyboard = [];
  const row = [
    {
      text: "📈 Chart",
      url: `https://dexscreener.com/solana/${t.mint}`,
    },
  ];
  if (siteUrl) {
    row.unshift({
      text: "🌐 OGfinder",
      url: `${siteUrl}/?q=${encodeURIComponent(queryLabel)}`,
    });
  }
  keyboard.push(row);
  return { text: lines.join("\n"), keyboard };
}

/** Head-to-head /compare card for two scanned CAs. */
export function compareMessage(
  a: ScanVerdict,
  b: ScanVerdict,
  siteUrl: string | null
): VerdictMessage {
  const lines: string[] = [];
  lines.push("⚔️ <b>HEAD-TO-HEAD</b>");
  lines.push("");

  const entries: Array<{ v: ScanVerdict; tag: string }> = [
    { v: a, tag: "🅰️" },
    { v: b, tag: "🅱️" },
  ];
  for (const { v, tag } of entries) {
    const label = tokenLabel(
      v.scanName ?? v.scanned?.displayName ?? null,
      v.scanSymbol ?? v.scanned?.displaySymbol ?? null
    );
    const verdict = v.isScannedOG
      ? "🏆 OG of its name"
      : v.scannedRank != null
        ? `❌ #${v.scannedRank} of ${v.totalFound} by age`
        : "❓ unranked";
    lines.push(`${tag} ${label} — ${verdict}`);
    lines.push(`🗓 ${mintedLine(v.scanned)}`);
    const market = marketLine(v.scanned);
    if (market) lines.push(market);
    lines.push(`🪙 <code>${escapeHtml(v.scannedMint)}</code>`);
    lines.push("");
  }

  const aMs = a.scanned?.createdAtMs;
  const bMs = b.scanned?.createdAtMs;
  if (aMs != null && bMs != null && aMs !== bMs) {
    const older = aMs < bMs ? "🅰️" : "🅱️";
    lines.push(
      `⏳ ${older} is older by ${formatAgeGap(Math.abs(aMs - bMs))}`
    );
  }

  const sameGroup =
    a.query && b.query && a.query.toLowerCase() === b.query.toLowerCase();
  if (sameGroup) {
    lines.push(`🧬 Same name group ("${escapeHtml(a.query)}") — the older one is the OG.`);
  }

  const keyboard: TgInlineKeyboard = [];
  if (siteUrl) {
    keyboard.push([
      {
        text: "🌐 Open A on OGfinder",
        url: buildShareUrl(siteUrl, a),
      },
      {
        text: "🌐 Open B",
        url: buildShareUrl(siteUrl, b),
      },
    ]);
  }
  return { text: lines.join("\n").trimEnd(), keyboard };
}

const SOL_FMT = (n: number) =>
  `${n >= 0 ? "+" : ""}${n.toFixed(2)} SOL`;

/** /wallet summary card (site parity: PnL, top coin, hold time, side wallets). */
export function walletMessage(
  w: WalletAnalysis,
  siteUrl: string | null
): VerdictMessage {
  const lines: string[] = [];
  lines.push(`👛 <b>WALLET</b> <code>${escapeHtml(truncateMint(w.address))}</code>`);
  lines.push("");
  const pnlEmoji = w.totalPnlSol >= 0 ? "🟢" : "🔴";
  const usd =
    w.totalPnlUsd != null ? ` (${fmtUsd(Math.abs(w.totalPnlUsd))} ${w.totalPnlUsd >= 0 ? "gain" : "loss"})` : "";
  lines.push(`${pnlEmoji} PnL: <b>${SOL_FMT(w.totalPnlSol)}</b>${usd}`);
  if (w.solBalanceLamports != null) {
    lines.push(`💎 Balance: ${(w.solBalanceLamports / 1e9).toFixed(3)} SOL`);
  }
  if (w.topCoin) {
    lines.push(
      `🏅 Top coin: <b>${escapeHtml(w.topCoin.name)}</b> ($${escapeHtml(w.topCoin.symbol)}) ${SOL_FMT(w.topCoin.pnlSol)}`
    );
  }
  if (w.avgHoldTimeMs > 0) {
    lines.push(`⏱ Avg hold: ${formatAgeGap(w.avgHoldTimeMs)}`);
  }
  lines.push(`🧾 Analyzed ${w.txCount} txs · ${w.holdings.length} holdings`);
  if (w.sideWallets.length > 0) {
    lines.push(`🕸 Side wallets detected: ${w.sideWallets.length}`);
  }
  if (w.truncated) {
    lines.push("");
    lines.push("⏳ Deep history truncated — full picture on the site.");
  }

  const keyboard: TgInlineKeyboard = [];
  if (siteUrl) {
    keyboard.push([
      {
        text: "🌐 Full analysis on OGfinder",
        url: `${siteUrl}/wallet?address=${encodeURIComponent(w.address)}`,
      },
    ]);
  }
  return { text: lines.join("\n"), keyboard };
}

export function helpMessage(botUsername: string, siteUrl: string | null): string {
  const site = siteUrl ? `\n🌐 Website: ${escapeHtml(siteUrl)}` : "";
  return [
    "🔎 <b>OGfinder bot</b> — is that CA the original, or a copycat?",
    "",
    "Paste any Solana CA (or a pump.fun / DexScreener / Solscan link) in a group I'm in and I'll scan it automatically: I find every token sharing its name, rank them by true on-chain age, and tell you if yours is the OG — exactly like the website.",
    "",
    "<b>Commands</b>",
    "/og &lt;CA or name&gt; — scan a mint or find the OG by name",
    "/search &lt;name&gt; — oldest tokens for a name, ranked",
    "/compare &lt;CA&gt; &lt;CA&gt; — head-to-head age battle",
    "/wallet &lt;address&gt; — quick wallet PnL + side wallets",
    "/trending — boosted Solana tokens right now, scan in one tap",
    "/watch &lt;CA&gt; — price/rug alerts for this chat (/watchlist, /unwatch)",
    "/settings — group auto-scan &amp; quiet mode (admins)",
    "/stats — this chat's scan stats",
    "/ping — am I alive?",
    "",
    `💡 Inline: type @${escapeHtml(botUsername)} &lt;name or CA&gt; in any chat.`,
    "⚙️ For auto-scan in groups, give me permission to read messages (BotFather → /setprivacy → Disable, or make me admin).",
    site,
  ].join("\n");
}

export function startMessage(botUsername: string, siteUrl: string | null): {
  text: string;
  keyboard: TgInlineKeyboard;
} {
  const text = [
    "👋 <b>gm! I'm the OGfinder bot.</b>",
    "",
    "Solana names get cloned endlessly — I tell you which mint came <b>first</b>.",
    "",
    "🔬 Paste any CA and I'll rank it against every token sharing its name by true on-chain creation time. Rank #1 = the OG. Everything else is a copy.",
    "",
    "Add me to your group and I'll scan every CA that gets posted, automatically.",
    "",
    "Try it now — paste a CA or type /help.",
  ].join("\n");
  const keyboard: TgInlineKeyboard = [
    [
      {
        text: "➕ Add me to a group",
        url: `https://t.me/${botUsername}?startgroup=true`,
      },
    ],
  ];
  if (siteUrl) {
    keyboard.push([{ text: "🌐 OGfinder website", url: siteUrl }]);
  }
  return { text, keyboard };
}
