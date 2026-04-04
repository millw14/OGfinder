"use client";

import { useState } from "react";

const WALLET = "CmLvaDkNRiJGRcWD3uEwVZLSyPUaMcFcZkaDnzhBwfrH";

export function DonationAddress() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(WALLET);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex items-center gap-2 rounded-full border border-gray-800/60 bg-gray-900/30 px-3 py-1.5 text-[11px] text-gray-500 transition-colors hover:border-gray-600 hover:bg-gray-800/40 hover:text-gray-300"
      title="Click to copy donation address"
    >
      <span className="font-medium">Donate SOL</span>
      <span className="font-mono text-gray-600 group-hover:text-gray-400">
        {WALLET.slice(0, 4)}...{WALLET.slice(-4)}
      </span>
      <span className="text-[10px]">{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}
