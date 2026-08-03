"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { WalletAnalysis } from "@/lib/types";

function formatHoldTime(ms: number): string {
  if (ms <= 0) return "N/A";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatSol(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/** Per-token SOL price — meme-coin costs are often far below 0.0001. */
function formatPerToken(v: number): string {
  if (v === 0) return "0";
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.001) return v.toFixed(4);
  return v.toExponential(1);
}

const compactQty = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/** Section label above each table — same eyebrow the hero cards use. */
const EYEBROW = "text-micro font-semibold uppercase tracking-[0.18em]";

/** Table chrome: one recessed header row over hairline-divided body rows. */
const TABLE_WRAP = "overflow-x-auto rounded-2xl border bg-surface-1";
const THEAD_ROW = `bg-surface-3 ${EYEBROW} text-fg-3`;
const TH = "px-3 py-2.5 font-semibold";
const TH_NUM = `${TH} text-right`;
const TD = "px-3 py-2.5";
const TD_NUM = `${TD} text-right font-mono tabular-nums`;
const ROW = "transition-colors hover:bg-surface-2";

function PnlColor({ value }: { value: number }) {
  const cls = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-fg-3";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={cls}>
      {sign}
      {formatSol(value)} SOL
    </span>
  );
}

/** Compact per-row copy-mint chip (same timer-in-ref pattern as TokenCard). */
function CopyMintButton({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — nothing to show */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : `Copy ${mint}`}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-micro font-medium transition-colors ${
        copied
          ? "border-up/25 bg-up/10 text-up"
          : "bg-surface-3 text-fg-3 hover:border-line-str hover:text-fg-2"
      }`}
    >
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
      {copied ? "Copied" : "CA"}
    </button>
  );
}

/** Links a wallet-row token to the OG finder scan for its mint. */
function CheckOGLink({ mint }: { mint: string }) {
  return (
    <Link
      href={`/?q=${encodeURIComponent(mint)}`}
      title="Is this the original token?"
      className="inline-flex items-center whitespace-nowrap rounded-full border border-og/25 bg-og/10 px-2 py-0.5 text-micro font-semibold text-og transition-colors hover:border-og/45 hover:bg-og/[0.16]"
    >
      Check OG
    </Link>
  );
}

/** Stat tile in the summary grid: micro-caps label over a mono headline. */
function StatCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-surface-1 p-4">
      <p className={`${EYEBROW} text-fg-4`}>{label}</p>
      {children}
    </div>
  );
}

export function WalletView({
  data,
  onDeepen,
  isDeepening,
}: {
  data: WalletAnalysis;
  onDeepen?: () => void;
  isDeepening?: boolean;
}) {
  const winTotal = data.winRate
    ? data.winRate.wins + data.winRate.losses
    : 0;

  return (
    <div className="space-y-8">
      {/* Data honesty banners */}
      {data.partial && (
        <div className="rounded-2xl border border-warn/30 border-l-2 border-l-warn/70 bg-warn/[0.07] px-4 py-3 text-meta leading-relaxed text-warn">
          Some wallet data could not be fetched — results may be incomplete.
        </div>
      )}
      {data.truncated && (
        <div className="rounded-2xl border border-warn/30 border-l-2 border-l-warn/70 bg-warn/[0.07] px-4 py-3 text-meta leading-relaxed text-warn">
          Analyzed last{" "}
          <span className="font-mono tabular-nums">{data.txCount}</span> txs
          {data.oldestTxMs
            ? ` since ${new Date(data.oldestTxMs).toLocaleDateString()}`
            : ""}{" "}
          — older history not included; P&amp;L may be incomplete.
          {data.canDeepen && onDeepen && (
            <button
              type="button"
              onClick={onDeepen}
              disabled={isDeepening}
              className="ml-2 mt-2 inline-flex items-center rounded-xl border border-og/35 px-3 py-1.5 text-meta font-semibold text-og/90 transition-colors hover:border-og/55 hover:bg-og/10 hover:text-og disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isDeepening ? "Scanning…" : "Scan more history"}
            </button>
          )}
        </div>
      )}

      {/* Summary stat grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total P&L">
          <p className="mt-2 font-mono text-xl font-medium tabular-nums sm:text-2xl">
            <PnlColor value={data.totalPnlSol} />
          </p>
          {data.totalPnlUsd != null && (
            <p className="mt-1 font-mono text-micro tabular-nums text-fg-4">
              ~${data.totalPnlUsd.toLocaleString()}
            </p>
          )}
          {data.solBalanceLamports != null && (
            <p className="mt-0.5 text-micro text-fg-4">
              <span className="font-mono tabular-nums text-fg-3">
                {formatSol(data.solBalanceLamports / 1e9)}
              </span>{" "}
              SOL balance
            </p>
          )}
        </StatCard>

        <StatCard label="Top Coin">
          {data.topCoin ? (
            <>
              <p className="mt-2 truncate font-display text-lg font-bold tracking-tight text-fg">
                {data.topCoin.symbol}
              </p>
              <p className="mt-1 font-mono text-micro tabular-nums">
                <PnlColor value={data.topCoin.pnlSol} />
              </p>
            </>
          ) : (
            <p className="mt-2 text-meta text-fg-3">No swaps found</p>
          )}
        </StatCard>

        <StatCard label="Avg Hold Time">
          <p className="mt-2 font-mono text-xl font-medium tabular-nums text-fg sm:text-2xl">
            {formatHoldTime(data.avgHoldTimeMs)}
          </p>
          <p className="mt-1 text-micro text-fg-4">
            <span className="font-mono tabular-nums text-fg-3">
              {data.txCount}
            </span>{" "}
            txs analyzed
          </p>
        </StatCard>

        <StatCard label="Win Rate">
          {data.winRate && winTotal > 0 ? (
            <>
              <p className="mt-2 font-mono text-xl font-medium tabular-nums text-fg sm:text-2xl">
                {data.winRate.pct}%
              </p>
              <p className="mt-1 font-mono text-micro tabular-nums text-fg-4">
                <span className="text-up">{data.winRate.wins}W</span>
                <span className="text-fg-4"> / </span>
                <span className="text-down">{data.winRate.losses}L</span>
              </p>
            </>
          ) : (
            <p className="mt-2 font-mono text-xl font-medium tabular-nums text-fg-4 sm:text-2xl">
              —
            </p>
          )}
        </StatCard>
      </div>

      {/* Token P&L table */}
      {data.tokenPnl.length > 0 && (
        <div>
          <h3 className={`mb-2.5 px-1 ${EYEBROW} text-fg-4`}>Token P&amp;L</h3>
          <div className={TABLE_WRAP}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Token</th>
                  <th className={TH_NUM}>Bought</th>
                  <th className={TH_NUM}>Sold</th>
                  <th className={`hidden sm:table-cell ${TH_NUM}`}>Avg Cost</th>
                  <th className={`hidden md:table-cell ${TH_NUM}`}>
                    Remaining
                  </th>
                  <th className={TH_NUM}>P&amp;L</th>
                  <th className={`hidden sm:table-cell ${TH_NUM}`}>
                    Hold Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.tokenPnl.map((t) => {
                  const totalPnl = t.realizedPnlSol + t.unrealizedPnlSol;
                  return (
                    <tr key={t.mint} className={ROW}>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                          <span className="font-medium text-fg">
                            {t.symbol}
                            {t.approxUsd && (
                              <sup
                                title="Includes USDC/USDT-quoted swaps valued at the current SOL price — approximate"
                                className="ml-0.5 cursor-help text-micro text-scan"
                              >
                                ≈
                              </sup>
                            )}
                            {t.basisIncomplete && (
                              <sup
                                title="Sold more than bought in the analyzed window — cost basis incomplete"
                                className="ml-0.5 cursor-help text-micro text-warn"
                              >
                                †
                              </sup>
                            )}
                          </span>
                          <span className="text-micro text-fg-4">
                            {t.name !== t.symbol ? t.name : ""}
                          </span>
                          <CheckOGLink mint={t.mint} />
                          <CopyMintButton mint={t.mint} />
                        </div>
                      </td>
                      <td className={`${TD_NUM} text-fg-2`}>
                        {formatSol(t.totalBoughtSol)}
                      </td>
                      <td className={`${TD_NUM} text-fg-2`}>
                        {formatSol(t.totalSoldSol)}
                      </td>
                      <td className={`hidden sm:table-cell ${TD_NUM} text-fg-3`}>
                        {t.avgCostSol != null
                          ? formatPerToken(t.avgCostSol)
                          : "—"}
                      </td>
                      <td className={`hidden md:table-cell ${TD_NUM} text-fg-3`}>
                        {t.remainingQty != null
                          ? compactQty.format(t.remainingQty)
                          : "—"}
                      </td>
                      <td className={`${TD_NUM} font-medium`}>
                        <PnlColor value={totalPnl} />
                      </td>
                      <td className={`hidden sm:table-cell ${TD_NUM} text-fg-3`}>
                        {formatHoldTime(t.holdTimeMs)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Current holdings */}
      {data.holdings.length > 0 && (
        <div>
          <h3 className={`mb-2.5 px-1 ${EYEBROW} text-fg-4`}>
            Current Holdings ({data.holdings.length})
          </h3>
          <div className={TABLE_WRAP}>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Token</th>
                  <th className={TH_NUM}>Amount</th>
                  <th className={TH_NUM}>Value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.holdings.slice(0, 30).map((h) => (
                  <tr key={h.mint} className={ROW}>
                    <td className={TD}>
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="font-medium text-fg">{h.symbol}</span>
                        <span className="text-micro text-fg-4">
                          {h.name !== h.symbol ? h.name : ""}
                        </span>
                        <CheckOGLink mint={h.mint} />
                        <CopyMintButton mint={h.mint} />
                      </div>
                    </td>
                    <td className={`${TD_NUM} text-fg-2`}>
                      {h.amount >= 1
                        ? h.amount.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })
                        : h.amount.toFixed(Math.min(h.decimals, 6))}
                    </td>
                    <td className={`${TD_NUM} text-fg-2`}>
                      {h.valueUsd != null
                        ? `$${h.valueUsd.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Side wallets */}
      {data.sideWallets.length > 0 && (
        <div>
          <h3 className={`mb-2.5 px-1 ${EYEBROW} text-fg-4`}>
            Possible Side Wallets
          </h3>
          <div className="space-y-2">
            {data.sideWallets.map((sw) => (
              <div
                key={sw.address}
                className="flex items-center justify-between gap-3 rounded-2xl border bg-surface-1 px-4 py-3 transition-colors hover:border-line-str"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-fg">
                    {truncAddr(sw.address)}
                  </p>
                  <p className="mt-0.5 text-micro text-fg-4">
                    <span className="font-mono tabular-nums text-fg-3">
                      {sw.interactionCount}
                    </span>{" "}
                    interactions
                    {sw.direction === "both"
                      ? " (sent & received)"
                      : sw.direction === "sent"
                        ? " (sent)"
                        : " (received)"}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className="font-mono text-meta tabular-nums text-fg-2">
                    {formatSol(sw.totalSolTransferred)} SOL
                  </span>
                  <Link
                    href={`/wallet?address=${encodeURIComponent(sw.address)}`}
                    title="Scan this wallet"
                    className="inline-flex items-center rounded-full border border-scan/25 bg-scan/10 px-2.5 py-1 text-micro font-semibold text-scan transition-colors hover:border-scan/45 hover:bg-scan/[0.16]"
                  >
                    Scan
                  </Link>
                  <a
                    href={`https://solscan.io/account/${sw.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center rounded-full border bg-surface-3 px-2.5 py-1 text-micro font-medium text-fg-3 transition-colors hover:border-line-str hover:text-fg"
                  >
                    Solscan
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-micro text-fg-4">
        Analyzed <span className="font-mono tabular-nums">{data.txCount}</span>{" "}
        transactions in{" "}
        <span className="font-mono tabular-nums">
          {(data.timing / 1000).toFixed(1)}s
        </span>
      </p>
    </div>
  );
}
