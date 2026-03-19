"use client";

import { useState, useEffect, useRef } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
}

export function SearchBar({ onSearch, isLoading }: SearchBarProps) {
  const [value, setValue] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (trimmed.length < 2) return;

    debounceRef.current = setTimeout(() => {
      onSearch(trimmed);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, onSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      onSearch(trimmed);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-xl">
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-5">
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-yellow-500" />
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
          placeholder="Search token name... e.g. pepe, doge, bonk"
          maxLength={30}
          autoFocus
          className="w-full rounded-2xl border border-gray-700/80 bg-gray-900/80 py-4 pl-14 pr-5 text-base text-gray-100 placeholder-gray-500 outline-none backdrop-blur-sm transition-all focus:border-yellow-500/60 focus:ring-2 focus:ring-yellow-500/20 sm:text-lg"
        />
      </div>
      <p className="mt-2.5 text-center text-[11px] text-gray-600">
        Min. 2 characters — searches DexScreener + Jupiter tokens
      </p>
    </form>
  );
}
