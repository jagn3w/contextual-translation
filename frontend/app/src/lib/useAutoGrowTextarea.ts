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
    // `scrollHeight` is the content box plus padding and excludes the borders, but Tailwind's
    // preflight makes every box `border-box`, so the height we write has to *contain* them.
    // Written as `needed` alone, a bordered textarea (the context field is `border border-line`)
    // ends up with a padding box 2px shorter than its content, and `overflow-hidden` quietly eats
    // the difference — worst on CJK glyphs, which fill the em box, in a field meant to be typed
    // in Spanish and Japanese. It never self-corrects either: the ResizeObserver pass measures
    // the same numbers and rewrites the same value, so it settles short rather than growing out
    // of it. Measured here, with the box already collapsed, so any CSS min-height cancels out of
    // the subtraction and only the borders are left. (The source textarea is unbordered and gets
    // 0, which is why it never showed the bug.)
    const borders = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = needed === 0 ? "" : `${needed + borders}px`;
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
