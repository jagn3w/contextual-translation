import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Runs one async action at a time and says whether it is still running — the pending state for a
 * button whose handler returns a promise. A second call while one is in flight is dropped (it
 * resolves undefined), which is the double-click guard the disabled button can't give during the
 * render between the click and the re-render that disables it.
 */
export function usePending(): [boolean, <T>(action: () => Promise<T>) => Promise<T | undefined>] {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    try {
      return await action();
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return [pending, run];
}
