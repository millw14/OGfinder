"use client";

import { useState, useEffect, useRef } from "react";

const WALLET = "CmLvaDkNRiJGRcWD3uEwVZLSyPUaMcFcZkaDnzhBwfrH";

export function DonationAddress() {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(WALLET);
      setCopyFailed(false);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      timerRef.current = setTimeout(() => setCopyFailed(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex min-h-[36px] items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1.5 text-micro text-fg-3 transition-colors hover:border-line-str hover:bg-surface-2 hover:text-fg-2"
      title="Click to copy donation address"
    >
      <span className="font-medium">Donate SOL</span>
      <span className="font-mono text-fg-4 group-hover:text-fg-3">
        {WALLET.slice(0, 4)}...{WALLET.slice(-4)}
      </span>
      <span className={`text-[10px]${copyFailed ? " text-risk" : ""}`}>
        {copied ? "Copied!" : copyFailed ? "Copy failed" : "Copy"}
      </span>
    </button>
  );
}
