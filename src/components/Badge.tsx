"use client";

export function OGBadge({ rank }: { rank: number }) {
  if (rank !== 1) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-900/40 px-3 py-1 text-xs font-bold uppercase tracking-wide text-yellow-400 ring-1 ring-yellow-600/50">
      <span>👑</span>
      <span>OG</span>
    </span>
  );
}

export function ConfidenceStars({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(5, score));
  return (
    <span
      className="inline-flex gap-px text-xs"
      title={`Confidence: ${clamped}/5`}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={i < clamped ? "text-yellow-500" : "text-gray-700"}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export function PlatformBadge({ dexId }: { dexId: string | null }) {
  if (!dexId) return null;

  let label: string;
  let colors: string;

  if (dexId === "pumpfun") {
    label = "Pump.fun";
    colors = "bg-pink-950/60 text-pink-400 ring-pink-800/50";
  } else if (dexId === "pumpswap") {
    label = "PumpSwap";
    colors = "bg-pink-950/60 text-pink-400 ring-pink-800/50";
  } else if (dexId === "raydium") {
    label = "Raydium";
    colors = "bg-purple-950/60 text-purple-400 ring-purple-800/50";
  } else {
    label = dexId.charAt(0).toUpperCase() + dexId.slice(1);
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
