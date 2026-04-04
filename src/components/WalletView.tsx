"use client";

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

export function WalletView({ data }: { data: WalletAnalysis }) {
  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                        <span className="font-medium text-gray-200">
                          {t.symbol}
                        </span>
                        <span className="ml-1.5 text-xs text-gray-500">
                          {t.name !== t.symbol ? t.name : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {formatSol(t.totalBoughtSol)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {formatSol(t.totalSoldSol)}
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
                      <span className="font-medium text-gray-200">
                        {h.symbol}
                      </span>
                      <span className="ml-1.5 text-xs text-gray-500">
                        {h.name !== h.symbol ? h.name : ""}
                      </span>
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
                className="flex items-center justify-between rounded-lg border border-gray-800/40 bg-gray-900/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={`/wallet?address=${sw.address}`}
                    className="font-mono text-sm text-cyan-400 hover:text-cyan-300"
                  >
                    {truncAddr(sw.address)}
                  </a>
                  <p className="text-xs text-gray-500">
                    {sw.interactionCount} interactions
                    {sw.direction === "both"
                      ? " (sent & received)"
                      : sw.direction === "sent"
                        ? " (sent)"
                        : " (received)"}
                  </p>
                </div>
                <div className="text-right text-sm text-gray-400">
                  {formatSol(sw.totalSolTransferred)} SOL
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
