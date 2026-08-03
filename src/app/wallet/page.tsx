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
import { SiteFooter } from "@/components/SiteFooter";
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
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-str border-t-og" />
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
      <div className="page-ambient pointer-events-none fixed inset-0" aria-hidden />

      <NavTabs />

      <main className="relative mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8 sm:pt-12">
        <div className="mb-7 text-center">
          <p className="text-micro font-semibold uppercase tracking-[0.18em] text-scan">
            Wallet scanner
          </p>
          <h1 className="mt-2 font-display text-[34px] font-bold leading-[1.05] tracking-tight text-fg sm:text-[40px]">
            Read the wallet
          </h1>
          <p className="mx-auto mt-3 max-w-md text-balance text-sm leading-relaxed text-fg-2">
            Paste a Solana address for realized P&amp;L, hold times, current
            holdings and the side wallets it trades with.
          </p>
        </div>

        {/* Same shell treatment as the main search: the focus ring lives on the
            wrapper, the input suppresses its own outline. */}
        <form onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl">
          <div className="relative flex items-center rounded-[14px] border bg-surface-1 transition-all duration-200 hover:border-line-str focus-within:border-og/50 focus-within:shadow-[0_0_0_3px_rgba(240,180,41,0.12),0_0_36px_-6px_rgba(240,180,41,0.28)] motion-reduce:transition-none">
            <span
              aria-hidden
              className="pointer-events-none absolute left-4 flex items-center sm:left-5"
            >
              {isLoading ? (
                <span className="block h-[18px] w-[18px] animate-spin rounded-full border-2 border-line-str border-t-og" />
              ) : (
                <svg
                  className="h-[18px] w-[18px] text-fg-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  <path d="M16 12h3" />
                </svg>
              )}
            </span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Paste wallet address…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="h-14 w-full rounded-[14px] bg-transparent pl-11 pr-[92px] font-mono text-[15px] text-fg outline-none placeholder:font-sans placeholder:text-fg-4 sm:h-16 sm:pl-14 sm:pr-[104px] sm:text-base"
            />
            <button
              type="submit"
              disabled={isLoading || !address.trim()}
              className="absolute right-2 inline-flex h-10 flex-shrink-0 items-center rounded-xl bg-og px-4 text-meta font-semibold text-bg transition-colors hover:bg-og-light disabled:opacity-40 sm:h-11 sm:px-5 sm:text-sm"
            >
              {isLoading ? "Scanning…" : "Scan"}
            </button>
          </div>
        </form>

        {!data && !isLoading && !error && recentWallets.length > 0 && (
          <div className="mt-7 text-center">
            <p className="mb-2.5 text-micro font-medium uppercase tracking-[0.14em] text-fg-4">
              Recent wallets
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {recentWallets.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => scanWallet(w)}
                  title={w}
                  className="inline-flex min-h-[36px] items-center rounded-full border bg-surface-2 px-3 py-1.5 font-mono text-meta text-fg-2 transition-colors hover:border-line-str hover:text-og sm:min-h-0"
                >
                  {truncAddr(w)}
                </button>
              ))}
            </div>
          </div>
        )}

        {isLoading && (
          <div className="mt-14 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-line-str border-t-og" />
            <p className="mt-3.5 text-meta text-fg-3">
              Analyzing wallet — pulling swaps, prices and transfers…
            </p>
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-2xl border border-down/30 border-l-2 border-l-down/70 bg-down/[0.06] px-5 py-6 text-center">
            <p className="font-display text-[15px] font-medium tracking-tight text-down">
              {error}
            </p>
            <p className="mt-2 text-meta text-fg-3">
              Paste a full base58 Solana address — 32–44 characters.
            </p>
          </div>
        )}

        {data && (
          <div className="mt-8 sm:mt-10">
            <WalletView
              data={data}
              onDeepen={deepenScan}
              isDeepening={isDeepening}
            />
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
