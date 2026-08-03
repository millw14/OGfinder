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
  /** Added client-side when flattening: the owning watch's display query. */
  watchQuery?: string;
}

interface WatchAlerts {
  id: number;
  displayQuery: string;
  kind: string;
  telegramLinked: boolean;
  alerts: AlertItem[];
}

const MAX_DROPDOWN_ROWS = 20;

/** Row glyph: a gold bolt for OG flips, a neutral spark for new clones. */
function AlertGlyph({ isFlip }: { isFlip: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border ${
        isFlip ? "border-og/30 bg-og/10 text-og" : "bg-surface-2 text-fg-3"
      }`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isFlip ? (
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v8M8 12h8" />
          </>
        )}
      </svg>
    </span>
  );
}

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
  const [tgLinkedIds, setTgLinkedIds] = useState<Set<number>>(() => new Set());
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
        .flatMap((w) =>
          (w.alerts ?? []).map((a) => ({ ...a, watchQuery: w.displayQuery }))
        )
        .sort((a, b) => b.matchedAt - a.matchedAt);
      setAlerts(flat);
      setTgLinkedIds(
        new Set(
          (data.watches ?? [])
            .filter((w) => w.telegramLinked)
            .map((w) => w.id)
        )
      );
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

  // Telegram footer row: a "TG ✓" chip once any watch is linked, else a
  // link-out for the first watch that carries a stored deep link.
  const tgLinked = watches.some((w) => tgLinkedIds.has(w.id));
  const tgLinkTarget = tgLinked
    ? null
    : (watches.find((w) => w.telegramLinkUrl)?.telegramLinkUrl ?? null);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={hasUnseen ? "Alerts — new clones found" : "Alerts"}
        title="Clone alerts for your watched names"
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-surface-1 hover:text-fg-2 sm:h-9 sm:w-9"
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
            className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-og ring-2 ring-bg sm:right-2 sm:top-2"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-line-str bg-surface-1/95 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)] backdrop-blur-md sm:w-80">
          <p className="border-b px-3.5 py-2.5 text-micro font-semibold uppercase tracking-[0.18em] text-fg-4">
            Clone alerts
          </p>
          {alerts.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-meta leading-relaxed text-fg-3">
              No new clones spotted for your watches yet
            </p>
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto">
              {alerts.slice(0, MAX_DROPDOWN_ROWS).map((a) => {
                const isFlip = a.kind === "flip";
                const target = isFlip ? a.watchQuery : a.mint;
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => target && goTo(target)}
                      disabled={!target}
                      className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-default"
                    >
                      <AlertGlyph isFlip={isFlip} />
                      <span className="min-w-0 flex-1">
                        {isFlip ? (
                          <>
                            <span className="block truncate text-meta font-semibold text-og">
                              {a.watchQuery ?? "Watched name"}: copycat flipped
                              the OG
                            </span>
                            {a.name && (
                              <span className="text-micro text-fg-4">
                                {a.name} now leads
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="block truncate text-meta font-semibold text-fg">
                              {a.name ?? "Unnamed token"}
                              {a.symbol && (
                                <span className="ml-1 font-mono text-micro font-normal text-fg-3">
                                  ${a.symbol}
                                </span>
                              )}
                            </span>
                            {a.source && (
                              <span className="text-micro text-fg-4">
                                via {a.source}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                      <span className="mt-0.5 flex-shrink-0 font-mono text-micro text-fg-4">
                        {timeAgo(new Date(a.matchedAt).toISOString())}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {tgLinked ? (
            <p className="border-t px-3.5 py-2 text-center text-micro font-medium text-scan">
              TG ✓ Telegram alerts on
            </p>
          ) : tgLinkTarget ? (
            <a
              href={tgLinkTarget}
              target="_blank"
              rel="noopener noreferrer"
              className="block border-t px-3.5 py-2 text-center text-micro font-medium text-scan transition-colors hover:bg-surface-2"
            >
              Get Telegram alerts
            </a>
          ) : null}
          <a
            href="/alerts"
            className="block border-t px-3.5 py-2.5 text-center text-micro font-semibold text-og/90 transition-colors hover:bg-surface-2 hover:text-og"
          >
            Manage watches &amp; alerts
          </a>
        </div>
      )}
    </div>
  );
}
