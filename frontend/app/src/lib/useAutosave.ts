import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export type Autosave = {
  /** What the indicator says: "saving" from the first unsaved keystroke until the server has it. */
  state: SaveState;
  /** Saves now instead of after the pause, resolving once the latest text is saved (or failed). */
  flush: () => Promise<void>;
  /**
   * Records that the server now holds `value` — e.g. Get feedback saved it on the way. When the
   * draft has moved on since (typed while the review was out), the draft is sent again at once:
   * the review's write may have landed over a newer save.
   */
  markSaved: (value: string) => void;
};

/**
 * Every mounted autosave's flush, plus the unmount flushes still running. Signing out awaits them
 * all first (flushAutosaves): a save sent after the session is gone is refused, and the draft with it.
 */
const pendingFlushes = new Set<() => Promise<void>>();

/**
 * Stops waiting on every save still out, when a session is retired (sessionState.ts): its results are
 * dropped, so they would never settle, and the next sign-out's flushAutosaves would wait out its
 * timeout on them.
 */
export function forgetPendingAutosaves(): void {
  pendingFlushes.clear();
}

/**
 * Saves every draft still pending anywhere in the app, resolving once each has landed or failed —
 * or after `timeoutMs`, since a save that hangs mustn't keep the learner from signing out.
 */
export async function flushAutosaves(timeoutMs = 5000): Promise<void> {
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all([...pendingFlushes].map((flush) => flush())), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Saves `value` a short pause after the last edit, one request at a time: an edit made while a save
 * is in flight is picked up by a follow-up save as soon as it lands, never by a second request
 * racing the first, so the server can't end up with an older draft than the one on screen.
 *
 * `savedValue` is what the server holds when the hook mounts — by default `value` itself; pass the
 * server's copy when the draft starts ahead of it, and the difference is saved after the pause.
 * Mount it once per entry (key the component on the entry id): unmounting — switching entries,
 * leaving the page — saves anything still pending rather than dropping it. `save` resolves false
 * (or rejects) on failure; the draft stays dirty and the next edit tries again.
 */
export function useAutosave(
  value: string,
  save: (value: string) => Promise<boolean>,
  delay = 800,
  savedValue: string = value,
): Autosave {
  // What the server holds, as far as we know; null once we can't know, which forces a save.
  const saved = useRef<string | null>(savedValue);
  const latest = useRef(value);
  latest.current = value;
  const saveRef = useRef(save);
  saveRef.current = save;
  const running = useRef<Promise<void> | null>(null);
  // Bumped by markSaved: a save that was in flight across one can't claim the server holds its text.
  const marks = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<SaveState>("idle");

  const flush = useCallback((): Promise<void> => {
    if (running.current !== null) return running.current;
    const run = (async () => {
      try {
        while (latest.current !== saved.current) {
          const sending = latest.current;
          const mark = marks.current;
          if (mounted.current) setState("saving");
          const ok = await saveRef.current(sending).catch(() => false);
          if (!ok) {
            if (mounted.current) setState("error");
            return;
          }
          // A review wrote its own text while this was out, and which of the two the server kept
          // depends on which it got last: send the draft once more to be sure.
          saved.current = marks.current === mark ? sending : null;
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
    pendingFlushes.add(flush);
    return () => {
      mounted.current = false;
      // Still registered until this last save settles, so a sign-out straight after waits for it.
      void flush().finally(() => {
        if (!mounted.current) pendingFlushes.delete(flush);
      });
    };
  }, [flush]);

  const markSaved = useCallback(
    (text: string) => {
      saved.current = text;
      marks.current += 1;
      if (latest.current === text) setState("saved");
      else void flush();
    },
    [flush],
  );

  // Dirty text reads as saving straight away rather than after the pause: "Saved" beside words the
  // server hasn't got would be the one wrong thing this indicator could say. A failure stays shown
  // until the next attempt actually starts.
  const dirty = value !== saved.current;
  return { state: dirty && state !== "error" ? "saving" : state, flush, markSaved };
}
