"use client";

import { useRef, useEffect } from "react";
import Lottie, { LottieRefCurrentProps } from "lottie-react";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

type Props = {
  animationData: unknown;
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
};

/**
 * Plays the animation on hover; resets to frame 0 when pointer leaves.
 * With prefers-reduced-motion, hover is a no-op and the animation parks on
 * its final frame (frame 0 of a draw-on Lottie is blank).
 */
export function LottieHover({
  animationData,
  className,
  size = 28,
  "aria-hidden": ariaHidden = true,
}: Props) {
  const ref = useRef<LottieRefCurrentProps>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!reduced) return;
    const inst = ref.current;
    if (!inst) return;
    const frames = inst.getDuration(true);
    inst.goToAndStop(frames != null && frames > 0 ? frames - 1 : 0, true);
  }, [reduced]);

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      onMouseEnter={() => {
        if (reduced) return;
        ref.current?.stop();
        ref.current?.play();
      }}
      onMouseLeave={() => {
        if (reduced) return;
        ref.current?.stop();
        ref.current?.goToAndStop(0, true);
      }}
      aria-hidden={ariaHidden}
    >
      <Lottie
        lottieRef={ref}
        animationData={animationData}
        loop={false}
        autoplay={false}
        style={{ width: size, height: size }}
      />
    </div>
  );
}
