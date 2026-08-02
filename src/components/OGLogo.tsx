"use client";

import { useRef, useEffect, useCallback } from "react";
import Lottie, { LottieRefCurrentProps } from "lottie-react";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import letterO from "@/assets/lottie/letter-o.json";
import letterG from "@/assets/lottie/letter-g.json";

const LETTER_SIZE = 64;
/** Time between each full draw animation cycle */
const REPEAT_MS = 4000;

type Props = {
  className?: string;
  /** Rendered size of each letter in px. Defaults to the hero size. */
  size?: number;
  /** Loop the draw-on every {@link REPEAT_MS}. Off for the header lockup —
   *  it draws once on mount and then only replays on hover. */
  autoReplay?: boolean;
};

/**
 * Wired-style animated “O” + “G” for the OGfinder wordmark.
 * Replays in sync every {@link REPEAT_MS}; hover also replays.
 * With prefers-reduced-motion the letters park fully drawn instead
 * (frame 0 of a draw-on Lottie is blank — the wordmark must stay visible).
 */
export function OGLogo({
  className,
  size = LETTER_SIZE,
  autoReplay = true,
}: Props) {
  const refO = useRef<LottieRefCurrentProps>(null);
  const refG = useRef<LottieRefCurrentProps>(null);
  const reduced = usePrefersReducedMotion();

  const playBoth = useCallback(() => {
    if (reduced) return;
    refO.current?.stop();
    refG.current?.stop();
    refO.current?.goToAndStop(0, true);
    refG.current?.goToAndStop(0, true);
    refO.current?.play();
    refG.current?.play();
  }, [reduced]);

  const parkAtEnd = useCallback(() => {
    for (const ref of [refO, refG]) {
      const inst = ref.current;
      if (!inst) continue;
      const frames = inst.getDuration(true);
      inst.goToAndStop(frames != null && frames > 0 ? frames - 1 : 0, true);
    }
  }, []);

  useEffect(() => {
    if (reduced) {
      parkAtEnd();
      return;
    }
    playBoth();
    if (!autoReplay) return;
    const id = setInterval(playBoth, REPEAT_MS);
    return () => clearInterval(id);
  }, [playBoth, parkAtEnd, reduced, autoReplay]);

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
          style={{ width: size, height: size }}
        />
      </span>
      <span
        className={`og-logo-lottie inline-flex cursor-default items-center justify-center ${
          size === LETTER_SIZE ? "-ml-1 sm:-ml-1.5" : ""
        }`}
        style={
          size === LETTER_SIZE
            ? undefined
            : { marginLeft: -Math.round(size * 0.0625) }
        }
        onMouseEnter={playBoth}
        aria-hidden
      >
        <Lottie
          lottieRef={refG}
          animationData={letterG}
          loop={false}
          autoplay={false}
          style={{ width: size, height: size }}
        />
      </span>
    </span>
  );
}
