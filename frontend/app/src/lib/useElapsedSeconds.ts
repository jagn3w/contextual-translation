import { useEffect, useRef, useState } from "react";

/** Seconds since `active` became true, ticking once a second; null when inactive. */
export function useElapsedSeconds(active: boolean): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const started = useRef(0);
  useEffect(() => {
    if (!active) {
      setElapsed(null);
      return;
    }
    started.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

/**
 * The hint beside a button that asks Claude something: nothing for the first two seconds (most
 * answers land by then, and a counter that flashes "0s" reads as a glitch), then the running count.
 */
export function askingClaude(elapsed: number | null): string | null {
  return elapsed !== null && elapsed >= 2 ? `Asking Claude… ${elapsed}s` : null;
}
