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
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-xl">
      <div className="relative overflow-hidden rounded-2xl shadow-lg shadow-black/20 ring-1 ring-white/5">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-5">
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-amber-400" />
          ) : (
            <svg
              className="h-5 w-5 text-gray-500"
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
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Token name, mint (CA), or social / website URL…"
          maxLength={MAX_SOCIAL_URL}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="w-full rounded-2xl border border-gray-700/80 bg-gray-900/90 py-4 pl-14 pr-5 text-base text-gray-100 placeholder-gray-500 outline-none backdrop-blur-sm transition-all focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/15 sm:text-lg"
        />
      </div>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-gray-600">
        {hintCompare ? (
          <span className="text-cyan-500/90">
            Two mints detected — comparing head-to-head
          </span>
        ) : hintMint ? (
          <span className="text-cyan-500/90">
            Mint detected — resolving name and comparing against older mints
          </span>
        ) : hintSocial ? (
          <span className="text-amber-500/85">
            Link detected — finding tokens with this URL in DexScreener socials
          </span>
        ) : hintDeadZone ? (
          <span className="text-red-400/90">
            Not searchable — too long for a name (max {MAX_QUERY}), too short
            for a mint ({32}–{MAX_MINT_LEN})
          </span>
        ) : (
          <>
            <span className="text-gray-500">
              Name: {MIN_QUERY}–{MAX_QUERY} characters
            </span>
            <span className="text-gray-700"> · </span>
            <span className="text-gray-500">
              Mint {32}–{MAX_MINT_LEN} · URL up to {MAX_SOCIAL_URL}
            </span>
          </>
        )}
      </p>
    </form>
  );
}
