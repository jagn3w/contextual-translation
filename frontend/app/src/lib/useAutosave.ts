import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export type Autosave = {
  /** What the indicator says: "saving" from the first unsaved keystroke until the server has it. */
  state: SaveState;
  /** Saves now instead of after the pause, resolving once the latest text is saved (or failed). */
  flush: () => Promise<void>;
  /** Records that the server already has `value` — e.g. Get feedback saved it on the way. */
  markSaved: (value: string) => void;
};

/**
 * Saves `value` a short pause after the last edit, one request at a time: an edit made while a save
 * is in flight is picked up by a follow-up save as soon as it lands, never by a second request
 * racing the first, so the server can't end up with an older draft than the one on screen.
 *
 * The value it is first called with counts as saved. Mount it once per entry (key the component on
 * the entry id): unmounting — switching entries, leaving the page — saves anything still pending
 * rather than dropping it. `save` resolves false (or rejects) on failure; the draft stays dirty and
 * the next edit tries again.
 */
export function useAutosave(value: string, save: (value: string) => Promise<boolean>, delay = 800): Autosave {
  const saved = useRef(value);
  const latest = useRef(value);
  latest.current = value;
  const saveRef = useRef(save);
  saveRef.current = save;
  const running = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [state, setState] = useState<SaveState>("idle");

  const flush = useCallback((): Promise<void> => {
    if (running.current !== null) return running.current;
    const run = (async () => {
      try {
        while (latest.current !== saved.current) {
          const sending = latest.current;
          if (mounted.current) setState("saving");
          const ok = await saveRef.current(sending).catch(() => false);
          if (!ok) {
            if (mounted.current) setState("error");
            return;
          }
          saved.current = sending;
        }
        if (mounted.current) setState((current) => (current === "idle" ? "idle" : "saved"));
      } finally {
        running.current = null;
      }
    })();
    running.current = run;
    return run;
  }, []);

  useEffect(() => {
    if (value === saved.current) return;
    const timer = window.setTimeout(() => void flush(), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay, flush]);

  useEffect(() => {
    // Set on every mount: StrictMode mounts, cleans up and mounts again with the same refs.
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush();
    };
  }, [flush]);

  const markSaved = useCallback((text: string) => {
    saved.current = text;
    if (latest.current === text) setState("saved");
  }, []);

  // Dirty text reads as saving straight away rather than after the pause: "Saved" beside words the
  // server hasn't got would be the one wrong thing this indicator could say. A failure stays shown
  // until the next attempt actually starts.
  const dirty = value !== saved.current;
  return { state: dirty && state !== "error" ? "saving" : state, flush, markSaved };
}
