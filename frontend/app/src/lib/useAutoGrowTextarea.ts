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

  // A narrower box rewraps the same text into more lines. Nothing else would re-measure until the
  // next keystroke, and with no scrollbar and no resize handle that stale height clips the text
  // for good. The observer watches the element rather than the window because the window is not
  // where every narrowing comes from: the document's scrollbar appearing takes ~15px off the
  // column and fires no resize event at all, which the window listener this replaces missed
  // entirely. Watching the box covers that, the md breakpoint and zoom under one rule.
  //
  // `fit` writes the height, which the observer then reports; that pass measures the same content
  // height and writes the same value, so no third pass is scheduled — the callback settles rather
  // than looping, because the box is always collapsed to `auto` before it is measured.
  useEffect(() => {
    const textarea = ref.current;
    // jsdom implements no ResizeObserver, and lays out nothing for one to report: there `fit`
    // takes its `scrollHeight === 0` path, so there is no measurement to keep current anyway.
    if (textarea === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [fit]);

  return ref;
}
