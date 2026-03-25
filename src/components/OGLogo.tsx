"use client";

import { useRef, useEffect, useCallback } from "react";
import Lottie, { LottieRefCurrentProps } from "lottie-react";
import letterO from "@/assets/lottie/letter-o.json";
import letterG from "@/assets/lottie/letter-g.json";

const LETTER_SIZE = 64;
/** Time between each full draw animation cycle */
const REPEAT_MS = 4000;

type Props = {
  className?: string;
};

/**
 * Wired-style animated “O” + “G” for the hero wordmark.
 * Replays in sync every {@link REPEAT_MS}; hover also replays.
 */
export function OGLogo({ className }: Props) {
  const refO = useRef<LottieRefCurrentProps>(null);
  const refG = useRef<LottieRefCurrentProps>(null);

  const playBoth = useCallback(() => {
    refO.current?.stop();
    refG.current?.stop();
    refO.current?.goToAndStop(0, true);
    refG.current?.goToAndStop(0, true);
    refO.current?.play();
    refG.current?.play();
  }, []);

  useEffect(() => {
    playBoth();
    const id = setInterval(playBoth, REPEAT_MS);
    return () => clearInterval(id);
  }, [playBoth]);

  return (
    <span
      className={`inline-flex items-center justify-center leading-none ${className ?? ""}`}
    >
      <span
        className="og-logo-lottie inline-flex cursor-default items-center justify-center"
        onMouseEnter={playBoth}
        aria-hidden
      >
        <Lottie
          lottieRef={refO}
          animationData={letterO}
          loop={false}
          autoplay={false}
          style={{ width: LETTER_SIZE, height: LETTER_SIZE }}
        />
      </span>
      <span
        className="og-logo-lottie -ml-1 inline-flex cursor-default items-center justify-center sm:-ml-1.5"
        onMouseEnter={playBoth}
        aria-hidden
      >
        <Lottie
          lottieRef={refG}
          animationData={letterG}
          loop={false}
          autoplay={false}
          style={{ width: LETTER_SIZE, height: LETTER_SIZE }}
        />
      </span>
    </span>
  );
}
