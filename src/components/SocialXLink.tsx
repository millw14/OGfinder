"use client";

import { LottieHover } from "@/components/LottieHover";
import logoX from "@/assets/lottie/logo-x.json";

export function SocialXLink() {
  return (
    <a
      href="https://x.com/ms_millaa"
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-2 rounded-full border border-gray-700/60 bg-gray-900/40 px-3 py-1.5 text-gray-500 transition-colors hover:border-gray-600 hover:bg-gray-800/50 hover:text-gray-300"
      title="ms_millaa on X"
    >
      <LottieHover
        animationData={logoX}
        size={22}
        className="shrink-0 opacity-90 group-hover:opacity-100"
      />
      <span className="text-[11px] font-medium">@ms_millaa</span>
    </a>
  );
}
