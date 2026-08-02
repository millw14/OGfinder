"use client";

import { useState, useRef, useEffect } from "react";
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

function PnlColor({ value }: { value: number }) {
  const cls =
    value > 0 ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-gray-400";
  const sign = value > 0 ? "+" : "";
  return <span className={cls}>{sign}{formatSol(value)} SOL</span>;
}

/** Compact per-row copy-mint button (same timer-in-ref pattern as TokenCard). */
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
      className={`rounded-md border border-gray-700/50 bg-gray-800/50 px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:border-gray-600 hover:bg-gray-800/80 ${
        copied ? "text-emerald-400" : "text-gray-500 hover:text-gray-300"
      }`}
    >
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
      className="whitespace-nowrap rounded-md border border-amber-700/30 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500/90 transition-colors hover:border-amber-600/50 hover:bg-amber-950/50 hover:text-amber-400"
    >
      Check OG
    </Link>
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
    <div className="space-y-6">
      {/* Data honesty banners */}
      {data.partial && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-900/20 px-4 py-3 text-center text-sm text-amber-400">
          Some wallet data could not be fetched — results may be incomplete.
        </div>
      )}
      {data.truncated && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-900/20 px-4 py-3 text-center text-sm text-amber-400">
          Analyzed last {data.txCount} txs
          {data.oldestTxMs
            ? ` since ${new Date(data.oldestTxMs).toLocaleDateString()}`
            : ""}{" "}
          — older history not included; P&L may be incomplete.
          {data.canDeepen && onDeepen && (
            <button
              type="button"
              onClick={onDeepen}
              disabled={isDeepening}
              className="ml-2 mt-1 inline-block rounded-lg border border-amber-600/40 bg-amber-900/40 px-2.5 py-1 text-xs font-semibold text-amber-300 transition-colors hover:border-amber-500/60 hover:bg-amber-900/60 hover:text-amber-200 disabled:opacity-50"
            >
              {isDeepening ? "Scanning..." : "Scan more history"}
            </button>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-800/60 bg-gray-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Total P&L
          </p>
          <p className="mt-1 text-2xl font-bold">
            <PnlColor value={data.totalPnlSol} />
          </p>
          {data.totalPnlUsd != null && (
            <p className="mt-0.5 text-xs text-gray-500">
              ~${data.totalPnlUsd.toLocaleString()}
            </p>
          )}
          {data.solBalanceLamports != null && (
            <p className="mt-0.5 text-xs text-gray-500">
              {formatSol(data.solBalanceLamports / 1e9)} SOL balance
            </p>
          )}
        </div>

        <div className="rounded-xl border border-gray-800/60 bg-gray-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Top Coin
          </p>
          {data.topCoin ? (
            <>
              <p className="mt-1 truncate text-lg font-bold text-gray-100">
                {data.topCoin.symbol}
              </p>
              <p className="text-xs text-gray-400">
                <PnlColor value={data.topCoin.pnlSol} />
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-gray-500">No swaps found</p>
          )}
        </div>

        <div className="rounded-xl border border-gray-800/60 bg-gray-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Avg Hold Time
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-100">
            {formatHoldTime(data.avgHoldTimeMs)}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.txCount} txs analyzed
          </p>
        </div>

        <div className="rounded-xl border border-gray-800/60 bg-gray-900/50 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
            Win Rate
          </p>
          {data.winRate && winTotal > 0 ? (
            <>
              <p className="mt-1 text-2xl font-bold text-gray-100">
                {data.winRate.pct}%
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {data.winRate.wins}W / {data.winRate.losses}L
              </p>
            </>
          ) : (
            <p className="mt-1 text-2xl font-bold text-gray-500">—</p>
          )}
        </div>
      </div>

      {/* Token P&L table */}
      {data.tokenPnl.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Token P&L
          </h3>
          <div className="overflow-x-auto rounded-xl border border-gray-800/60">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800/40 text-xs uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2 text-right">Bought</th>
                  <th className="px-3 py-2 text-right">Sold</th>
                  <th className="hidden px-3 py-2 text-right sm:table-cell">
                    Avg Cost
                  </th>
                  <th className="hidden px-3 py-2 text-right md:table-cell">
                    Remaining
                  </th>
                  <th className="px-3 py-2 text-right">P&L</th>
                  <th className="hidden px-3 py-2 text-right sm:table-cell">
                    Hold Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokenPnl.map((t) => {
                  const totalPnl = t.realizedPnlSol + t.unrealizedPnlSol;
                  return (
                    <tr
                      key={t.mint}
                      className="border-b border-gray-800/20 hover:bg-gray-800/20"
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                          <span className="font-medium text-gray-200">
                            {t.symbol}
                            {t.approxUsd && (
                              <sup
                                title="Includes USDC/USDT-quoted swaps valued at the current SOL price — approximate"
                                className="ml-0.5 cursor-help text-xs text-sky-400"
                              >
                                ≈
                              </sup>
                            )}
                            {t.basisIncomplete && (
                              <sup
                                title="Sold more than bought in the analyzed window — cost basis incomplete"
                                className="ml-0.5 cursor-help text-xs text-amber-500"
                              >
                                †
                              </sup>
                            )}
                          </span>
                          <span className="text-xs text-gray-500">
                            {t.name !== t.symbol ? t.name : ""}
                          </span>
                          <CheckOGLink mint={t.mint} />
                          <CopyMintButton mint={t.mint} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {formatSol(t.totalBoughtSol)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {formatSol(t.totalSoldSol)}
                      </td>
                      <td className="hidden px-3 py-2 text-right text-gray-500 sm:table-cell">
                        {t.avgCostSol != null
                          ? formatPerToken(t.avgCostSol)
                          : "—"}
                      </td>
                      <td className="hidden px-3 py-2 text-right text-gray-500 md:table-cell">
                        {t.remainingQty != null
                          ? compactQty.format(t.remainingQty)
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        <PnlColor value={totalPnl} />
                      </td>
                      <td className="hidden px-3 py-2 text-right text-gray-500 sm:table-cell">
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
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Current Holdings ({data.holdings.length})
          </h3>
          <div className="overflow-x-auto rounded-xl border border-gray-800/60">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800/40 text-xs uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2">Token</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.slice(0, 30).map((h) => (
                  <tr
                    key={h.mint}
                    className="border-b border-gray-800/20 hover:bg-gray-800/20"
                  >
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span className="font-medium text-gray-200">
                          {h.symbol}
                        </span>
                        <span className="text-xs text-gray-500">
                          {h.name !== h.symbol ? h.name : ""}
                        </span>
                        <CheckOGLink mint={h.mint} />
                        <CopyMintButton mint={h.mint} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">
                      {h.amount >= 1
                        ? h.amount.toLocaleString(undefined, {
                            maximumFractionDigits: 2,
                          })
                        : h.amount.toFixed(Math.min(h.decimals, 6))}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">
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
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Possible Side Wallets
          </h3>
          <div className="space-y-2">
            {data.sideWallets.map((sw) => (
              <div
                key={sw.address}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-800/40 bg-gray-900/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-gray-300">
                    {truncAddr(sw.address)}
                  </p>
                  <p className="text-xs text-gray-500">
                    {sw.interactionCount} interactions
                    {sw.direction === "both"
                      ? " (sent & received)"
                      : sw.direction === "sent"
                        ? " (sent)"
                        : " (received)"}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className="text-sm text-gray-400">
                    {formatSol(sw.totalSolTransferred)} SOL
                  </span>
                  <Link
                    href={`/wallet?address=${encodeURIComponent(sw.address)}`}
                    title="Scan this wallet"
                    className="rounded-lg bg-cyan-600/20 px-2.5 py-1 text-[11px] font-semibold text-cyan-400 ring-1 ring-cyan-600/30 transition-colors hover:bg-cyan-600/30 hover:text-cyan-300"
                  >
                    Scan
                  </Link>
                  <a
                    href={`https://solscan.io/account/${sw.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg bg-gray-800/70 px-2.5 py-1 text-[11px] font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-100"
                  >
                    Solscan
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-gray-600">
        Analyzed {data.txCount} transactions in {(data.timing / 1000).toFixed(1)}s
      </p>
    </div>
  );
}
