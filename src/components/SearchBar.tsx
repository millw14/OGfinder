"use client";

import { useState, useEffect, useRef } from "react";
import { isLikelyMintAddress } from "@/lib/solana";
import { parseCompareInput } from "@/lib/compare";
import { MIN_QUERY, MAX_QUERY, MAX_MINT_LEN, MAX_SOCIAL_URL } from "@/lib/types";
import { isLikelySocialUrl } from "@/lib/social-url";

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
}

function shouldTriggerSearch(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  if (isLikelySocialUrl(trimmed)) {
    return trimmed.length >= 8 && trimmed.length <= MAX_SOCIAL_URL;
  }
  if (parseCompareInput(trimmed)) return true;
  const mint = isLikelyMintAddress(trimmed);
  if (mint && trimmed.length >= 32 && trimmed.length <= MAX_MINT_LEN) {
    return true;
  }
  if (!mint && trimmed.length >= MIN_QUERY && trimmed.length <= MAX_QUERY) {
    return true;
  }
  return false;
}

export function SearchBar({ onSearch, isLoading }: SearchBarProps) {
  const [value, setValue] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!shouldTriggerSearch(trimmed)) return;

    debounceRef.current = setTimeout(() => {
      onSearch(trimmed);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, onSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (shouldTriggerSearch(trimmed)) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      onSearch(trimmed);
    }
  };

  /** Local-only reset: the last search on screen is deliberately kept. */
  const handleClear = () => {
    setValue("");
    inputRef.current?.focus();
  };

  const trimmed = value.trim();
  const hintCompare = parseCompareInput(trimmed) !== null;
  const hintMint =
    trimmed.length >= 32 &&
    trimmed.length <= MAX_MINT_LEN &&
    isLikelyMintAddress(trimmed);
  const hintSocial =
    isLikelySocialUrl(trimmed) &&
    trimmed.length >= 8 &&
    trimmed.length <= MAX_SOCIAL_URL;
  // Dead zone: too long for a name search, but not a valid mint or URL either
  // (e.g. a 31-char base58 string, or a name over MAX_QUERY characters).
  const hintDeadZone =
    !hintCompare && !hintMint && !hintSocial && trimmed.length > MAX_QUERY;

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-2xl">
      {/* The focus treatment lives on the shell (the input suppresses its own
          outline) — gold hairline + ring + a soft outer glow. */}
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
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Token name, mint (CA), or social link…"
          maxLength={MAX_SOCIAL_URL}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-14 w-full rounded-[14px] bg-transparent pl-11 pr-12 font-mono text-[15px] text-fg outline-none placeholder:font-sans placeholder:text-fg-4 sm:h-16 sm:pl-14 sm:pr-14 sm:text-base"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            title="Clear"
            className="absolute right-1.5 inline-flex h-11 w-11 items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg sm:right-2 sm:h-9 sm:w-9"
          >
            <span className="sr-only">Clear search</span>
            <svg
              aria-hidden
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 6l12 12M18 6L6 18"
              />
            </svg>
          </button>
        )}
      </div>
      <p className="mt-3 text-center text-micro leading-relaxed">
        {hintCompare ? (
          <span className="text-scan">
            Two mints detected — comparing head-to-head
          </span>
        ) : hintMint ? (
          <span className="text-scan">
            Mint detected — resolving name and comparing against older mints
          </span>
        ) : hintSocial ? (
          <span className="text-warn">
            Link detected — finding tokens with this URL in DexScreener socials
          </span>
        ) : hintDeadZone ? (
          <span className="text-down">
            Not searchable — too long for a name (max {MAX_QUERY}), too short
            for a mint ({32}–{MAX_MINT_LEN})
          </span>
        ) : (
          <>
            <span className="text-fg-3">
              Name{" "}
              <span className="font-mono text-fg-4">
                {MIN_QUERY}–{MAX_QUERY}
              </span>
            </span>
            <span className="text-fg-4"> · </span>
            <span className="text-fg-3">
              Mint{" "}
              <span className="font-mono text-fg-4">
                {32}–{MAX_MINT_LEN}
              </span>
            </span>
            <span className="text-fg-4"> · </span>
            <span className="text-fg-3">
              URL up to{" "}
              <span className="font-mono text-fg-4">{MAX_SOCIAL_URL}</span>
            </span>
          </>
        )}
      </p>
    </form>
  );
}
