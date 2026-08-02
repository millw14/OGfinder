"use client";

import {
  Suspense,
  useState,
  useCallback,
  useEffect,
  useRef,
  FormEvent,
} from "react";
import { WalletAnalysis, WalletResponse } from "@/lib/types";
import { NavTabs } from "@/components/NavTabs";
import { WalletView } from "@/components/WalletView";
import { isLikelyMintAddress } from "@/lib/solana";
import { useRouter, useSearchParams } from "next/navigation";

const RECENT_KEY = "ogfinder_wallets";
const MAX_RECENT = 6;

function getRecentWallets(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === "string");
  } catch {
    return [];
  }
}

function addRecentWallet(addr: string) {
  const list = getRecentWallets().filter((a) => a !== addr);
  list.unshift(addr);
  if (list.length > MAX_RECENT) list.pop();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked — recents just don't persist */
  }
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

export default function WalletPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-cyan-500" />
        </div>
      }
    >
      <WalletPageInner />
    </Suspense>
  );
}

function WalletPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [address, setAddress] = useState("");
  const [data, setData] = useState<WalletAnalysis | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeepening, setIsDeepening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentWallets, setRecentWallets] = useState<string[]>([]);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Last address handed to scanWallet — lets the ?address= effect skip the
  // re-fire caused by our own router.replace after a successful scan.
  const lastScannedRef = useRef<string | null>(null);

  const scanWallet = useCallback(async (addr: string) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    setAddress(trimmed);
    lastScannedRef.current = trimmed;

    if (!isLikelyMintAddress(trimmed)) {
      setError("Invalid Solana wallet address");
      setData(null);
      return;
    }

    // Monotonic id + abort so a slow earlier scan can't clobber a newer one
    const reqId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch(
        `/api/wallet?address=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal }
      );
      const json: WalletResponse = await res.json();

      if (reqId !== requestIdRef.current) return; // stale response

      if (!res.ok || json.error) {
        setError(json.error ?? "Request failed");
        return;
      }

      if (json.data) {
        setData(json.data);
        addRecentWallet(trimmed);
        setRecentWallets(getRecentWallets());
        // Keep the URL shareable: it always reflects the scanned wallet.
        router.replace(`/wallet?address=${encodeURIComponent(trimmed)}`, {
          scroll: false,
        });
      }
    } catch {
      if (reqId !== requestIdRef.current) return; // aborted by a newer scan
      setError("Network error — try again");
    } finally {
      if (reqId === requestIdRef.current) setIsLoading(false);
    }
  }, [router]);

  // Deep scan: fetch older history server-side and replace data wholesale.
  // Existing results stay on screen while the merged window loads.
  const deepenScan = useCallback(async () => {
    const addr = lastScannedRef.current;
    if (!addr) return;

    const reqId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsDeepening(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/wallet?address=${encodeURIComponent(addr)}&deepen=1`,
        { signal: controller.signal }
      );
      const json: WalletResponse = await res.json();

      if (reqId !== requestIdRef.current) return; // stale response

      if (!res.ok || json.error) {
        setError(json.error ?? "Request failed");
        return;
      }

      if (json.data) setData(json.data);
    } catch {
      if (reqId !== requestIdRef.current) return; // aborted by a newer scan
      setError("Network error — try again");
    } finally {
      if (reqId === requestIdRef.current) setIsDeepening(false);
    }
  }, []);

  // Auto-scan from ?address= deep links (and side-wallet Scan navigations),
  // but never re-scan the address we just scanned ourselves.
  useEffect(() => {
    setRecentWallets(getRecentWallets());
    const addrParam = searchParams.get("address")?.trim();
    if (addrParam && addrParam !== lastScannedRef.current) {
      setAddress(addrParam);
      scanWallet(addrParam);
    }
  }, [searchParams, scanWallet]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    scanWallet(address);
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_90%_60%_at_50%_-15%,rgba(6,182,212,0.08),transparent_55%)]"
        aria-hidden
      />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-2xl flex-1 px-4 pb-12 pt-4 sm:pt-8">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-gray-100 sm:text-4xl">
            Wallet Scanner
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Paste a Solana wallet to see profits, hold times, and linked wallets
          </p>
        </div>

        <form onSubmit={handleSubmit} className="relative">
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Paste wallet address..."
            className="w-full rounded-xl border border-gray-700/60 bg-gray-900/60 px-4 py-3 pr-24 text-sm text-gray-200 placeholder-gray-600 outline-none transition-colors focus:border-cyan-600/60 focus:ring-1 focus:ring-cyan-600/30"
          />
          <button
            type="submit"
            disabled={isLoading || !address.trim()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-cyan-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-40"
          >
            {isLoading ? "Scanning..." : "Scan"}
          </button>
        </form>

        {!data && !isLoading && !error && recentWallets.length > 0 && (
          <div className="mt-6 text-center">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-600">
              Recent Wallets
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {recentWallets.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => scanWallet(w)}
                  className="rounded-full border border-gray-800/80 bg-gray-900/50 px-3 py-1 font-mono text-xs text-gray-400 transition-all hover:border-gray-600 hover:bg-gray-800/60 hover:text-gray-200"
                >
                  {truncAddr(w)}
                </button>
              ))}
            </div>
          </div>
        )}

        {isLoading && (
          <div className="mt-12 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-cyan-500" />
            <p className="mt-3 text-sm text-gray-500">
              Analyzing wallet...
            </p>
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        {data && (
          <div className="mt-6">
            <WalletView
              data={data}
              onDeepen={deepenScan}
              isDeepening={isDeepening}
            />
          </div>
        )}
      </main>

    </div>
  );
}
