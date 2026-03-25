"use client";

import { useRef } from "react";
import Lottie, { LottieRefCurrentProps } from "lottie-react";

type Props = {
  animationData: unknown;
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
};

/**
 * Plays the animation on hover; resets to frame 0 when pointer leaves.
 */
export function LottieHover({
  animationData,
  className,
  size = 28,
  "aria-hidden": ariaHidden = true,
}: Props) {
  const ref = useRef<LottieRefCurrentProps>(null);

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      onMouseEnter={() => {
        ref.current?.stop();
        ref.current?.play();
      }}
      onMouseLeave={() => {
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
