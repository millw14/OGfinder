"use client";

import { LottieHover } from "@/components/LottieHover";
import logoX from "@/assets/lottie/logo-x.json";

export function SocialXLink() {
  return (
    <a
      href="https://x.com/ms_millaa"
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex min-h-[36px] items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1.5 text-fg-3 transition-colors hover:border-line-str hover:bg-surface-2 hover:text-fg-2"
      title="ms_millaa on X"
    >
      <LottieHover
        animationData={logoX}
        size={22}
        className="shrink-0 opacity-90 group-hover:opacity-100"
      />
      <span className="text-micro font-medium">@ms_millaa</span>
    </a>
  );
}
