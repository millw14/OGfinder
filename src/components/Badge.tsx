"use client";

import { LottieHover } from "./LottieHover";
import { bucketForToken, labelForBucket } from "@/lib/launchpads";
import crownOg from "@/assets/lottie/crown-og.json";

export function OGBadge({ rank }: { rank: number }) {
  if (rank !== 1) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-900/40 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-yellow-400 ring-1 ring-yellow-600/50">
      <span className="og-badge-crown inline-flex shrink-0">
        <LottieHover animationData={crownOg} size={20} className="shrink-0" />
      </span>
      <span>OG</span>
    </span>
  );
}

/** Stars = age-data quality (how reliable the creation time is), NOT OG-ness. */
export function ConfidenceStars({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(5, score));
  return (
    <span
      className="inline-flex gap-px text-xs"
      title={`Age data quality: ${clamped}/5 — how reliable this token's creation time is`}
    >
      <span className="sr-only">
        Age data quality {clamped} of 5
      </span>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={i < clamped ? "text-yellow-500" : "text-gray-700"}
        >
          ★
        </span>
      ))}
    </span>
  );
}

/** Neutral info chip for ranks 2+ whose name+symbol exactly match the query. */
export function ExactNameBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-gray-800/60 px-2 py-0.5 text-[10px] font-medium text-gray-400 ring-1 ring-gray-700/50"
      title="Name and symbol exactly match the search — says nothing about which token came first"
    >
      exact name
    </span>
  );
}

export function PlatformBadge({
  dexId,
  mint,
}: {
  dexId: string | null;
  mint: string;
}) {
  const bucket = bucketForToken(dexId, mint);
  if (bucket === "unknown") return null;

  let label: string;
  let colors: string;

  if (bucket === "pumpfun") {
    label = "Pump.fun";
    colors = "bg-pink-950/60 text-pink-400 ring-pink-800/50";
  } else if (bucket === "pumpswap") {
    label = "PumpSwap";
    colors = "bg-pink-950/60 text-pink-400 ring-pink-800/50";
  } else if (bucket === "raydium") {
    label = "Raydium";
    colors = "bg-purple-950/60 text-purple-400 ring-purple-800/50";
  } else if (bucket === "letsbonk") {
    label = "LetsBonk";
    colors = "bg-orange-950/60 text-orange-400 ring-orange-800/50";
  } else if (bucket === "meteora") {
    label = "Meteora";
    colors = "bg-red-950/60 text-red-400 ring-red-800/50";
  } else if (bucket === "orca") {
    label = "Orca";
    colors = "bg-sky-950/60 text-sky-400 ring-sky-800/50";
  } else if (bucket === "other") {
    label = dexId
      ? dexId.charAt(0).toUpperCase() + dexId.slice(1)
      : "Other";
    colors = "bg-gray-800/60 text-gray-400 ring-gray-700/50";
  } else {
    label = labelForBucket(bucket);
    colors = "bg-gray-800/60 text-gray-400 ring-gray-700/50";
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${colors}`}
    >
      {label}
    </span>
  );
}

export function ScannedMintBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-cyan-950/50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300 ring-1 ring-cyan-600/40">
      Your CA
    </span>
  );
}

export function BurnedBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-gray-800/60 px-2 py-0.5 text-[10px] font-medium text-gray-400 ring-1 ring-gray-700/50"
      title="On-chain supply is zero — this token has been fully burned"
    >
      Burned
    </span>
  );
}

export function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) {
    return (
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-yellow-500 text-base font-black text-black">
        1
      </div>
    );
  }

  if (rank <= 3) {
    return (
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-700 text-base font-bold text-gray-200">
        {rank}
      </div>
    );
  }

  return (
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-800/80 text-sm font-semibold text-gray-500">
      {rank}
    </div>
  );
}
