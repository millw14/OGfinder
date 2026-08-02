"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/lib/format";
import {
  StoredWatch,
  WATCHES_CHANGED_EVENT,
  getAlertsSeen,
  getStoredWatches,
  setAlertsSeen,
} from "@/lib/watch-client";

interface AlertItem {
  id: number;
  kind: string;
  mint: string | null;
  name: string | null;
  symbol: string | null;
  source: string | null;
  matchedAt: number;
}

interface WatchAlerts {
  id: number;
  displayQuery: string;
  kind: string;
  telegramLinked: boolean;
  alerts: AlertItem[];
}

const MAX_DROPDOWN_ROWS = 20;

function watchesQueryParam(watches: StoredWatch[]): string {
  return watches
    .slice(0, 10)
    .map((w) => `${w.id}:${w.secret}`)
    .join(",");
}

/**
 * Nav bell for in-app clone alerts. Hidden until the user has at least one
 * stored watch; an amber dot marks alerts newer than ogfinder_alerts_seen.
 */
export function AlertsBell() {
  const router = useRouter();
  const [watches, setWatches] = useState<StoredWatch[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setWatches(getStoredWatches());
    const onChange = () => setWatches(getStoredWatches());
    window.addEventListener(WATCHES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(WATCHES_CHANGED_EVENT, onChange);
  }, []);

  const fetchAlerts = useCallback(async (stored: StoredWatch[]) => {
    if (stored.length === 0) {
      setAlerts([]);
      setHasUnseen(false);
      return;
    }
    try {
      const res = await fetch(
        `/api/alerts?watches=${encodeURIComponent(watchesQueryParam(stored))}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { watches?: WatchAlerts[] };
      const flat = (data.watches ?? [])
        .flatMap((w) => w.alerts ?? [])
        .sort((a, b) => b.matchedAt - a.matchedAt);
      setAlerts(flat);
      const seen = getAlertsSeen();
      setHasUnseen(flat.some((a) => a.matchedAt > seen));
    } catch {
      /* alert feed is best-effort */
    }
  }, []);

  // Fetch on mount and whenever the stored watch list changes.
  useEffect(() => {
    void fetchAlerts(watches);
  }, [watches, fetchAlerts]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (watches.length === 0) return null;

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      void fetchAlerts(watches);
      setAlertsSeen(Date.now());
      setHasUnseen(false);
    }
  };

  const goTo = (mint: string) => {
    setOpen(false);
    router.push(`/?q=${encodeURIComponent(mint)}`);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={hasUnseen ? "Alerts — new clones found" : "Alerts"}
        title="Clone alerts for your watched names"
        className="relative rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-800/40 hover:text-gray-300"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {hasUnseen && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-[#0a0a0f]"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-gray-800 bg-gray-900/95 shadow-xl shadow-black/40 backdrop-blur-md sm:w-80">
          <p className="border-b border-gray-800/70 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Clone alerts
          </p>
          {alerts.length === 0 ? (
            <p className="px-3.5 py-5 text-center text-xs text-gray-600">
              No new clones spotted for your watches yet
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {alerts.slice(0, MAX_DROPDOWN_ROWS).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => a.mint && goTo(a.mint)}
                    disabled={!a.mint}
                    className="flex w-full items-baseline justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-gray-800/50 disabled:cursor-default"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-gray-200">
                        {a.name ?? "Unnamed token"}
                        {a.symbol && (
                          <span className="ml-1 font-medium text-gray-500">
                            ${a.symbol}
                          </span>
                        )}
                      </span>
                      {a.source && (
                        <span className="text-[10px] text-gray-600">
                          via {a.source}
                        </span>
                      )}
                    </span>
                    <span className="flex-shrink-0 text-[10px] tabular-nums text-gray-600">
                      {timeAgo(new Date(a.matchedAt).toISOString())}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <a
            href="/alerts"
            className="block border-t border-gray-800/70 px-3.5 py-2.5 text-center text-[11px] font-medium text-amber-500/90 transition-colors hover:bg-gray-800/40 hover:text-amber-400"
          >
            Manage watches &amp; alerts
          </a>
        </div>
      )}
    </div>
  );
}
