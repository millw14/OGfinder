import type { Config } from "tailwindcss";

/**
 * OGfinder — "Obsidian & Gold".
 *
 * Every surface/semantic colour the UI is allowed to use lives here as a token.
 * Depth comes from hairline borders (`border-line` is the DEFAULT border colour)
 * over tinted fills — not from heavy drop shadows.
 */
const config: Config = {
  content: [
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        bg: "#07070b",
        "surface-1": "#0d0d13",
        "surface-2": "#14141c",
        "surface-3": "#1c1c26",
        line: "rgba(255,255,255,0.07)",
        "line-str": "rgba(255,255,255,0.13)",

        // Brand / semantic
        og: {
          DEFAULT: "#f0b429",
          light: "#ffd977",
        },
        scan: "#22d3ee",
        up: "#34d399",
        down: "#f87171",
        risk: "#ef4444",
        warn: "#f59e0b",

        // Text
        fg: "#f4f4f5",
        "fg-2": "#a1a1aa",
        "fg-3": "#71717a",
        "fg-4": "#52525b",
      },
      borderColor: {
        DEFAULT: "rgba(255,255,255,0.07)",
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        micro: ["0.6875rem", { lineHeight: "1rem" }], // 11px
        meta: ["0.75rem", { lineHeight: "1.125rem" }], // 12px
      },
      boxShadow: {
        "og-glow": "0 0 0 1px rgba(240,180,41,0.18), 0 0 24px rgba(240,180,41,0.14), 0 0 64px rgba(240,180,41,0.06)",
        "scan-glow": "0 0 0 1px rgba(34,211,238,0.16), 0 0 22px rgba(34,211,238,0.10)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        rise: "rise 200ms ease-out both",
        shimmer: "shimmer 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
