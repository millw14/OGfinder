"use client";

import { useEffect, useRef, useState } from "react";
import {
  StoredWatch,
  WatchKindClient,
  addStoredWatch,
  findStoredWatch,
  removeStoredWatch,
} from "@/lib/watch-client";

interface WatchButtonProps {
  /** Display query to watch (server validates 2-30 chars). */
  query: string;
  kind: WatchKindClient;
  /** Mint-cluster watches: the scanned mint that must never self-alert. */
  originMint?: string | null;
}

/** 12px bell — outline while idle, filled once the watch is armed. */
function BellIcon({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

/**
 * Gold watch control: hairline-outline "Watch for new clones" ↔ gold-tinted
 * "Watching" (click unwatches). Shape matches the Share verdict button it sits
 * beside. Persists {id, secret} in localStorage — no accounts.
 */
export function WatchButton({ query, kind, originMint }: WatchButtonProps) {
  const [watching, setWatching] = useState<StoredWatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setWatching(findStoredWatch(query, kind) ?? null);
  }, [query, kind]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showNotice = (text: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2500);
  };

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (watching) {
        // Unwatch. A 404 (already gone server-side) still clears local state.
        try {
          await fetch(
            `/api/watch?id=${watching.id}&secret=${encodeURIComponent(
              watching.secret
            )}`,
            { method: "DELETE" }
          );
        } catch {
          /* network error — still forget locally; the watch dies with storage */
        }
        removeStoredWatch(watching.id);
        setWatching(null);
        return;
      }
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          kind,
          ...(originMint ? { originMint } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        id?: number;
        secret?: string;
        telegramLinkUrl?: string | null;
        error?: string;
      } | null;
      if (!res.ok || typeof data?.id !== "number" || !data?.secret) {
        showNotice(
          res.status === 409
            ? "Watch limit reached"
            : res.status === 429
              ? "Slow down — try again shortly"
              : typeof data?.error === "string"
                ? data.error
                : "Couldn’t add watch"
        );
        return;
      }
      const stored: StoredWatch = {
        id: data.id,
        secret: data.secret,
        query,
        kind,
        createdAt: Date.now(),
        ...(typeof data.telegramLinkUrl === "string"
          ? { telegramLinkUrl: data.telegramLinkUrl }
          : {}),
      };
      addStoredWatch(stored);
      setWatching(stored);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={Boolean(watching)}
        title={
          watching
            ? "Stop watching this name"
            : "Get alerted when new lookalike tokens launch with this name"
        }
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-meta font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          watching
            ? "border-og/45 bg-og/[0.14] text-og hover:border-og/65 hover:bg-og/20"
            : "border-og/30 text-og/90 hover:border-og/50 hover:bg-og/10 hover:text-og"
        }`}
      >
        <BellIcon active={Boolean(watching)} />
        {watching ? "Watching" : "Watch for new clones"}
      </button>
      {notice && (
        <span role="status" className="text-micro font-medium text-warn">
          {notice}
        </span>
      )}
    </span>
  );
}
