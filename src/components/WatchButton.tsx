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

/**
 * Amber-outline watch pill: "Watch for new clones" ↔ "Watching" (click
 * unwatches). Persists {id, secret} in localStorage — no accounts.
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
    <span className="inline-flex items-center gap-1.5">
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
        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          watching
            ? "border-amber-500/60 bg-amber-950/40 text-amber-200 hover:border-amber-400/70"
            : "border-amber-600/50 text-amber-400/90 hover:border-amber-500/70 hover:bg-amber-950/30 hover:text-amber-300"
        }`}
      >
        {watching ? "Watching" : "Watch for new clones"}
      </button>
      {notice && (
        <span role="status" className="text-[11px] text-amber-500/90">
          {notice}
        </span>
      )}
    </span>
  );
}
