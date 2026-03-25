"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { TokenResult, SearchResponse } from "@/lib/types";
import { SearchBar } from "@/components/SearchBar";
import { Results, ScanSummary } from "@/components/Results";

/** Client-only: Lottie + canvas; avoids flaky dev SSR chunk splits (missing ./276.js). */
const OGLogo = dynamic(
  () =>
    import("@/components/OGLogo").then((m) => ({ default: m.OGLogo })),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden
        className="inline-flex h-16 w-[8.75rem] shrink-0 items-center justify-center rounded-xl bg-gray-800/25 sm:h-[4.25rem] sm:w-[9.25rem]"
      />
    ),
  }
);

const SocialXLink = dynamic(
  () =>
    import("@/components/SocialXLink").then((m) => ({
      default: m.SocialXLink,
    })),
  { ssr: false }
);

const RECENT_KEY = "ogfinder_recent";
const MAX_RECENT = 8;

function getRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addRecent(query: string) {
  const list = getRecent().filter((q) => q !== query);
  list.unshift(query);
  if (list.length > MAX_RECENT) list.pop();
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

export default function Home() {
  const [results, setResults] = useState<TokenResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [timing, setTiming] = useState<number | undefined>();
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanSummary | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  useEffect(() => {
    setRecentSearches(getRecent());
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    setIsLoading(true);
    setHasSearched(true);
    setSearchError(null);
    setScan(null);

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data: SearchResponse = await res.json();

      if (!res.ok) {
        setResults([]);
        setTiming(undefined);
        setLastQuery("");
        setSearchError(
          typeof data.error === "string" ? data.error : "Request failed"
        );
        return;
      }

      setLastQuery(data.query ?? "");
      setResults(data.results ?? []);
      setTiming(data.timing);
      if (data.mode === "scan" && data.scannedMint) {
        setScan({
          mode: "scan",
          isScannedOG: data.isScannedOG,
          scannedRank: data.scannedRank ?? null,
          scanName: data.scanName ?? null,
          scanSymbol: data.scanSymbol ?? null,
          scannedMint: data.scannedMint,
        });
      } else {
        setScan(null);
      }
      addRecent(query);
      setRecentSearches(getRecent());
    } catch {
      setResults([]);
      setTiming(undefined);
      setLastQuery("");
      setSearchError("Network error — try again");
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_90%_60%_at_50%_-15%,rgba(251,191,36,0.09),transparent_55%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_60%_40%_at_100%_50%,rgba(6,182,212,0.05),transparent_50%)]"
        aria-hidden
      />

      <main className="relative mx-auto w-full max-w-2xl flex-1 px-4 pb-12 pt-14 sm:pt-20">
        <div className="mb-10 text-center sm:mb-12">
          <h1 className="flex flex-wrap items-center justify-center gap-0 text-5xl font-black tracking-tight sm:text-6xl">
            <span className="sr-only">OGfinder</span>
            <span
              aria-hidden="true"
              className="flex flex-wrap items-center justify-center gap-0"
            >
              <OGLogo className="sm:scale-105" />
              <span className="text-gray-100">finder</span>
            </span>
          </h1>
          <p className="mt-3 max-w-md mx-auto text-sm text-gray-500 sm:text-base">
            Find the original Solana token by name — or paste a mint to see if
            yours is the oldest.
          </p>
        </div>

        <SearchBar onSearch={handleSearch} isLoading={isLoading} />

        {!hasSearched && recentSearches.length > 0 && (
          <div className="mt-8 text-center">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-600">
              Recent
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {recentSearches.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => handleSearch(q)}
                  className="rounded-full border border-gray-800/80 bg-gray-900/50 px-3.5 py-1.5 text-sm text-gray-400 transition-all hover:border-gray-600 hover:bg-gray-800/60 hover:text-gray-200"
                >
                  {q.length > 24 ? `${q.slice(0, 10)}…${q.slice(-6)}` : q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8">
          <Results
            results={results}
            lastQuery={lastQuery}
            isLoading={isLoading}
            hasSearched={hasSearched}
            timing={timing}
            error={searchError}
            scan={scan}
          />
        </div>
      </main>

      <footer className="relative border-t border-gray-800/40 py-6">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-4">
          <SocialXLink />
          <p className="text-center text-[11px] leading-relaxed text-gray-600">
            OGfinder — powered by{" "}
            <a
              href="https://helius.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 transition-colors hover:text-gray-300"
            >
              Helius
            </a>
            {" · "}
            <a
              href="https://dexscreener.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 transition-colors hover:text-gray-300"
            >
              DexScreener
            </a>
            {" · "}
            <a
              href="https://jup.ag"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 transition-colors hover:text-gray-300"
            >
              Jupiter
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
