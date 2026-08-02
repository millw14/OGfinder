import { TelegramClient, TelegramApiError } from "./telegram";
import { BotStore } from "./store";
import { BotConfig } from "./config";
import { fetchTokenSnapshots, TokenSnapshot } from "./handlers";
import { escapeHtml, fmtUsd, truncateMint } from "./format";

/**
 * Watchlist poller: every WATCH_INTERVAL_SEC, batch-fetch DexScreener data
 * for all watched mints and alert chats on big price moves or liquidity rugs.
 *
 * last_price/last_liq are REFERENCE values (set when the watch was added or
 * when the last alert fired), so slow drifts still trigger once they add up.
 */

const ALERT_COOLDOWN_MS = 30 * 60_000;
/** Liquidity drop fraction that counts as a rug warning. */
const RUG_DROP = 0.5;
/** Ignore liquidity alerts on dust pools. */
const MIN_LIQ_FOR_RUG = 1_000;

function priceAlertText(
  symbol: string | null,
  mint: string,
  changePct: number,
  price: number | null
): string {
  const arrow = changePct >= 0 ? "📈" : "📉";
  const label = symbol ? `$${escapeHtml(symbol)}` : `<code>${escapeHtml(truncateMint(mint))}</code>`;
  const now = price != null ? ` — now ${fmtUsd(price)}` : "";
  const sign = changePct >= 0 ? "+" : "";
  return `${arrow} <b>${label}</b> moved <b>${sign}${changePct.toFixed(1)}%</b> since your last checkpoint${now}`;
}

function rugAlertText(
  symbol: string | null,
  mint: string,
  fromLiq: number,
  toLiq: number
): string {
  const label = symbol ? `$${escapeHtml(symbol)}` : `<code>${escapeHtml(truncateMint(mint))}</code>`;
  const dropPct = Math.round((1 - toLiq / fromLiq) * 100);
  return `🚨 <b>RUG WARNING — ${label}</b>\nLiquidity dropped ${dropPct}% (${fmtUsd(fromLiq)} → ${fmtUsd(toLiq)})`;
}

export function startWatcher(
  tg: TelegramClient,
  store: BotStore,
  cfg: BotConfig
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = store.allWatches();
      if (rows.length === 0) return;
      const mints = Array.from(new Set(rows.map((r) => r.mint)));
      const snaps = await fetchTokenSnapshots(mints);
      const now = Date.now();

      for (const row of rows) {
        const snap: TokenSnapshot | undefined = snaps.get(row.mint);
        if (!snap) continue;

        // First data sighting — set the reference silently.
        if (row.last_price == null && row.last_liq == null) {
          if (snap.priceUsd != null || snap.liquidityUsd != null) {
            store.updateWatchSnapshot(
              row.chat_id,
              row.mint,
              snap.priceUsd,
              snap.liquidityUsd,
              false
            );
          }
          continue;
        }

        const cooled =
          row.last_alert_at == null || now - row.last_alert_at > ALERT_COOLDOWN_MS;
        if (!cooled) continue;

        let alertText: string | null = null;

        if (
          row.last_liq != null &&
          row.last_liq >= MIN_LIQ_FOR_RUG &&
          snap.liquidityUsd != null &&
          snap.liquidityUsd < row.last_liq * (1 - RUG_DROP)
        ) {
          alertText = rugAlertText(
            row.symbol ?? snap.symbol,
            row.mint,
            row.last_liq,
            snap.liquidityUsd
          );
        } else if (
          row.last_price != null &&
          row.last_price > 0 &&
          snap.priceUsd != null &&
          snap.priceUsd > 0
        ) {
          const changePct =
            ((snap.priceUsd - row.last_price) / row.last_price) * 100;
          if (Math.abs(changePct) >= cfg.watchAlertPct) {
            alertText = priceAlertText(
              row.symbol ?? snap.symbol,
              row.mint,
              changePct,
              snap.priceUsd
            );
          }
        }

        if (!alertText) continue;

        try {
          await tg.sendMessage({
            chat_id: row.chat_id,
            text: alertText,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📈 Chart",
                    url: `https://dexscreener.com/solana/${row.mint}`,
                  },
                  { text: "🔬 Re-scan OG", callback_data: `scan:${row.mint}` },
                ],
              ],
            },
          });
          // Reset the reference so the next alert measures from here.
          store.updateWatchSnapshot(
            row.chat_id,
            row.mint,
            snap.priceUsd,
            snap.liquidityUsd,
            true
          );
        } catch (err) {
          if (err instanceof TelegramApiError && err.code === 403) {
            // Bot was kicked from the chat — stop watching for it.
            store.removeWatch(row.chat_id, row.mint);
          } else {
            console.warn("[watcher] alert send failed:", err);
          }
        }
      }
    } catch (err) {
      console.warn("[watcher] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(tick, cfg.watchIntervalSec * 1000);
  // First pass shortly after boot to seed missing references.
  const kickoff = setTimeout(tick, 15_000);
  return () => {
    clearInterval(interval);
    clearTimeout(kickoff);
  };
}
