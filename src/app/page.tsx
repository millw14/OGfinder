"use client";

import { useState, useCallback, useEffect } from "react";
import { TokenResult, SearchResponse } from "@/lib/types";
import { SearchBar } from "@/components/SearchBar";
import { Results } from "@/components/Results";

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

  useEffect(() => {
    setRecentSearches(getRecent());
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    setIsLoading(true);
    setHasSearched(true);

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(query)}`
      );
      const data: SearchResponse = await res.json();
      setResults(data.results ?? []);
      setTiming(data.timing);
      addRecent(query);
      setRecentSearches(getRecent());
    } catch {
      setResults([]);
      setTiming(undefined);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-12 pt-16 sm:pt-24">
        {/* Header */}
        <div className="mb-10 text-center sm:mb-14">
          <h1 className="text-5xl font-black tracking-tight sm:text-6xl">
            <span className="text-yellow-500">OG</span>
            <span className="text-gray-100">finder</span>
          </h1>
          <p className="mt-3 text-sm text-gray-500 sm:text-base">
            Find the original Solana token. Who was first?
          </p>
        </div>

        {/* Search */}
        <SearchBar onSearch={handleSearch} isLoading={isLoading} />

        {/* Recent searches */}
        {!hasSearched && recentSearches.length > 0 && (
          <div className="mt-8 text-center">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-600">
              Recent
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {recentSearches.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSearch(q)}
                  className="rounded-full border border-gray-800/80 bg-gray-900/60 px-3.5 py-1.5 text-sm text-gray-400 transition-all hover:border-gray-600 hover:bg-gray-800/60 hover:text-gray-200"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        <div className="mt-8">
          <Results
            results={results}
            isLoading={isLoading}
            hasSearched={hasSearched}
            timing={timing}
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800/50 py-5 text-center text-[11px] text-gray-600">
        OGfinder &mdash; powered by{" "}
        <a href="https://helius.dev" target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 transition-colors">Helius</a>
        {" · "}
        <a href="https://dexscreener.com" target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 transition-colors">DexScreener</a>
        {" · "}
        <a href="https://jup.ag" target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-300 transition-colors">Jupiter</a>
      </footer>
    </div>
  );
}
