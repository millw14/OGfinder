"use client";

import { Suspense, useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  TokenResult,
  SearchResponse,
  ScanSummary,
  SearchHistory,
} from "@/lib/types";
import {
  parseCompareInput,
  emptyCompareSide,
  CompareState,
  CompareSideState,
} from "@/lib/compare";
import { SearchBar } from "@/components/SearchBar";
import { Results } from "@/components/Results";
import { ComparisonCard } from "@/components/ComparisonCard";
import { NavTabs } from "@/components/NavTabs";
import { SiteFooter } from "@/components/SiteFooter";
import { TELEGRAM_GROUP_URL } from "@/lib/links";

/** Client-only: Lottie + canvas; avoids flaky dev SSR chunk splits (missing ./276.js). */
const OGLogo = dynamic(
  () =>
    import("@/components/OGLogo").then((m) => ({ default: m.OGLogo })),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden
        className="inline-flex h-16 w-[7.75rem] shrink-0 items-center justify-center rounded-xl bg-surface-2/60"
      />
    ),
  }
);

/** Compact proof points under the search — the third opens the Telegram bot. */
const TRUST_ITEMS = [
  { label: "on-chain verified ages", icon: "check" as const },
  { label: "risk + dev checks", icon: "shield" as const },
  {
    label: "works in your Telegram group",
    icon: "send" as const,
    href: TELEGRAM_GROUP_URL,
  },
];

const TRUST_ICONS: Record<"check" | "shield" | "send", string> = {
  check: "M20 6 9 17l-5-5",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  send: "m22 2-7 20-4-9-9-4 20-7Z",
};

function TrustIcon({ name }: { name: "check" | "shield" | "send" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0 text-og"
    >
      <path d={TRUST_ICONS[name]} />
    </svg>
  );
}

const RECENT_KEY = "ogfinder_recent";
const MAX_RECENT = 8;

function getRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) && list.every((q) => typeof q === "string")
      ? list
      : [];
  } catch {
    return [];
  }
}

function addRecent(query: string) {
  const list = getRecent().filter((q) => q !== query);
  list.unshift(query);
  if (list.length > MAX_RECENT) list.pop();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

/** useSearchParams requires a Suspense boundary (same pattern as /wallet). */
export function HomeClient() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-str border-t-og" />
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}

function HomeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [results, setResults] = useState<TokenResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [timing, setTiming] = useState<number | undefined>();
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanSummary | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [searchMode, setSearchMode] = useState<
    "search" | "scan" | "social" | "compare" | null
  >(null);
  const [degraded, setDegraded] = useState<string[] | null>(null);
  const [history, setHistory] = useState<SearchHistory | null>(null);
  const [compare, setCompare] = useState<CompareState | null>(null);

  // Landing → working state. Purely presentational: the search bar itself is
  // never unmounted, only the hero around it tightens.
  const collapsed = hasSearched || results.length > 0;

  useEffect(() => {
    setRecentSearches(getRecent());
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const handleSearch = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestSeqRef.current;
      const isStale = () => requestId !== requestSeqRef.current;

      setIsLoading(true);
      setIsEnriching(false);
      setHasSearched(true);
      setSearchError(null);
      setScan(null);
      setSearchMode(null);
      setDegraded(null);
      setHistory(null);
      setCompare(null);

      const isAbort = (err: unknown) =>
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError");

      const applyResponse = (data: SearchResponse, preliminary: boolean) => {
        setLastQuery(data.query ?? "");
        setResults(data.results ?? []);
        setTiming(data.timing);
        setSearchMode(data.mode ?? "search");
        setIsEnriching(preliminary);
        setDegraded(data.degraded && data.degraded.length ? data.degraded : null);
        setHistory(data.history ?? null);
        if (data.mode === "scan" && data.scannedMint) {
          setScan({
            mode: "scan",
            isScannedOG: data.isScannedOG,
            scannedRank: data.scannedRank ?? null,
            scanName: data.scanName ?? null,
            scanSymbol: data.scanSymbol ?? null,
            scannedMint: data.scannedMint,
            ...(preliminary && data.verdictPreliminary === true
              ? { verdictPreliminary: true }
              : {}),
          });
        } else {
          setScan(null);
        }
      };

      const recordSearch = () => {
        addRecent(query);
        setRecentSearches(getRecent());
        // Keep the URL shareable: it always reflects the current search.
        router.replace(`/?q=${encodeURIComponent(query)}`, { scroll: false });
      };

      // ——— Compare mode: two full CA scans composed client-side ———
      // The combined "A vs B" string is NEVER sent to /api/search; each mint
      // runs its own full search (fast phase skipped = exactly 2 rate tokens).
      const compareInput = parseCompareInput(query);
      if (compareInput) {
        const { a, b } = compareInput;
        setSearchMode("compare");
        setLastQuery(query);
        setResults([]);
        setTiming(undefined);
        setCompare({
          a: emptyCompareSide(a),
          b: emptyCompareSide(b),
          loading: true,
        });
        recordSearch();

        const fetchSide = async (mint: string): Promise<CompareSideState> => {
          const side = emptyCompareSide(mint);
          const res = await fetch(`/api/search?q=${encodeURIComponent(mint)}`, {
            signal: controller.signal,
          });
          const data: SearchResponse = await res.json();
          if (!res.ok) {
            side.error =
              typeof data.error === "string" ? data.error : "Request failed";
            return side;
          }
          // The scanned mint is always pinned into its own results.
          side.token = (data.results ?? []).find((t) => t.mint === mint) ?? null;
          side.isScannedOG = data.isScannedOG ?? null;
          side.scannedRank = data.scannedRank ?? null;
          side.totalFound = data.totalFound ?? data.results?.length ?? null;
          return side;
        };

        const [ra, rb] = await Promise.allSettled([fetchSide(a), fetchSide(b)]);
        if (isStale() || controller.signal.aborted) return;
        const settle = (
          r: PromiseSettledResult<CompareSideState>,
          mint: string
        ): CompareSideState =>
          r.status === "fulfilled"
            ? r.value
            : { ...emptyCompareSide(mint), error: "Network error — try again" };
        setCompare({ a: settle(ra, a), b: settle(rb, b), loading: false });
        setIsLoading(false);
        return;
      }

      // ——— Fast phase (best-effort): instant results, signature scans skipped ———
      let fastApplied = false;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&phase=fast`,
          { signal: controller.signal }
        );
        const data: SearchResponse = await res.json();
        if (isStale()) return;
        if (res.ok) {
          const preliminary = data.enriching === true;
          applyResponse(data, preliminary);
          setIsLoading(false);
          recordSearch();
          fastApplied = true;
          // Server had the final result cached — no follow-up needed.
          if (!preliminary) return;
        }
        // Non-ok fast responses fall through: the full request owns errors.
      } catch (err) {
        if (isAbort(err) || isStale()) return;
        // Fast phase is best-effort — fall through to the full request.
      }

      // ——— Full phase (authoritative): verified on-chain ages ———
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        const data: SearchResponse = await res.json();
        if (isStale()) return;

        if (!res.ok) {
          if (fastApplied) {
            // Keep the fast results on screen; just stop the enriching pulse.
            setIsEnriching(false);
            return;
          }
          setResults([]);
          setTiming(undefined);
          setLastQuery("");
          setSearchMode(null);
          setSearchError(
            typeof data.error === "string" ? data.error : "Request failed"
          );
          return;
        }

        applyResponse(data, false);
        if (!fastApplied) recordSearch();
      } catch (err) {
        // Superseded request — a newer search aborted this one; stay silent.
        if (isAbort(err) || isStale()) return;
        if (fastApplied) {
          setIsEnriching(false);
          return;
        }
        setResults([]);
        setTiming(undefined);
        setLastQuery("");
        setSearchMode(null);
        setSearchError("Network error — try again");
      } finally {
        if (!isStale()) setIsLoading(false);
      }
    },
    [router]
  );

  // Auto-run ?q= from a shared URL exactly once on mount.
  const ranFromUrlRef = useRef(false);
  useEffect(() => {
    if (ranFromUrlRef.current) return;
    ranFromUrlRef.current = true;
    const q = searchParams.get("q")?.trim();
    if (q && q !== lastQuery) handleSearch(q);
  }, [searchParams, handleSearch, lastQuery]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="page-ambient pointer-events-none fixed inset-0" aria-hidden />

      <NavTabs />
      <main className="relative mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8 sm:pt-12">
        {/* Landing state owns the viewport; once a search runs the hero
            collapses to a compact lockup so the verdict leads. */}
        <div
          className={`text-center transition-all duration-200 ease-out motion-reduce:transition-none ${
            collapsed ? "mb-5" : "mb-8 sm:mb-10"
          }`}
        >
          <h1 className="flex flex-wrap items-center justify-center gap-0 font-display font-bold tracking-tight">
            <span className="sr-only">OGfinder</span>
            <span
              aria-hidden="true"
              className="flex flex-wrap items-center justify-center gap-0"
            >
              <OGLogo
                size={collapsed ? 38 : 64}
                className={collapsed ? undefined : "sm:scale-105"}
              />
              <span
                className={`font-display leading-none text-fg ${
                  collapsed
                    ? "text-[24px] sm:text-[26px]"
                    : "text-[44px] sm:text-[54px]"
                }`}
              >
                finder
              </span>
            </span>
          </h1>
          {!collapsed && (
            <p className="mx-auto mt-4 max-w-lg text-balance text-sm leading-relaxed text-fg-2 sm:text-[15px]">
              Paste a token name or contract address — we rank every lookalike
              by real on-chain age.
            </p>
          )}
        </div>

        {/* Mobile: search stays reachable while scrolling results — it parks
            just below the 56px app header (bg matches the body so content
            scrolls under it cleanly). */}
        <div className="sticky top-14 z-30 -mx-4 bg-bg/85 px-4 py-2 backdrop-blur-md sm:static sm:z-auto sm:m-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-0">
          <SearchBar onSearch={handleSearch} isLoading={isLoading} />
        </div>

        {!collapsed && (
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-1.5 text-micro text-fg-3 sm:gap-2">
            {TRUST_ITEMS.map(({ label, icon, href }) => {
              const inner = (
                <>
                  <TrustIcon name={icon} />
                  {label}
                </>
              );
              return (
                <li key={label}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border bg-surface-1 px-2.5 py-1 transition-colors hover:border-og/40 hover:text-og"
                    >
                      {inner}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border bg-surface-1 px-2.5 py-1">
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!hasSearched && recentSearches.length > 0 && (
          <div className="mt-7 text-center">
            <p className="mb-2.5 text-micro font-medium uppercase tracking-[0.14em] text-fg-4">
              Recent
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {recentSearches.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => handleSearch(q)}
                  className="rounded-full border bg-surface-2 px-3 py-1.5 text-meta text-fg-2 transition-colors hover:border-line-str hover:text-og"
                >
                  {q.length > 24 ? `${q.slice(0, 10)}…${q.slice(-6)}` : q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8">
          {searchMode === "compare" && compare ? (
            <ComparisonCard state={compare} />
          ) : (
            <Results
              results={results}
              lastQuery={lastQuery}
              searchMode={searchMode}
              isLoading={isLoading}
              isEnriching={isEnriching}
              hasSearched={hasSearched}
              timing={timing}
              error={searchError}
              scan={scan}
              degraded={degraded}
              history={history}
            />
          )}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
