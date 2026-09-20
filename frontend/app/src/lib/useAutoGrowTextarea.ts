import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Keeps a textarea exactly as tall as its text, so a pane grows instead of scrolling (design D1.4):
 * with no scrollbar and no resize handle, the only way to see all of a long draft is for the frame
 * itself to get taller.
 *
 * The box has to be collapsed before measuring — `scrollHeight` of an already-tall textarea reports
 * the height it has, never the smaller height it now needs, so deleting text would never shrink it.
 * jsdom lays nothing out and answers 0: that's the signal to hand the height back to CSS, which
 * keeps the frame's min-height and leaves the tests measuring nothing.
 */
export function useAutoGrowTextarea(value: string): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    const needed = textarea.scrollHeight;
    textarea.style.height = needed === 0 ? "" : `${needed}px`;
  }, []);

  // Layout effect, not effect: the resize lands in the same frame as the new text, so no flicker.
  useLayoutEffect(fit, [fit, value]);

  // A narrower window rewraps the same text into more lines. Nothing else would re-measure until
  // the next keystroke, and with the scrollbar gone that stale height would clip text for good.
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  return ref;
}
