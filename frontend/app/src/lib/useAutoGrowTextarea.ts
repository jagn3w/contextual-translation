import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * How tall this element's own CSS will let it get, in px — Infinity when nothing caps it, so the
 * clamp below is a `Math.min`-shaped no-op wherever no ceiling was asked for.
 *
 * Only a px answer counts. `getComputedStyle` resolves `none` to the word, and viewport units to
 * pixels (they are absolute lengths), but a percentage stays a percentage — and jsdom, which
 * resolves nothing and applies no stylesheet, hands back whatever it was given or the empty string.
 * `parseFloat` would read "50%" as a 50-pixel ceiling and collapse the box to a single line, which
 * is a worse failure than not clamping at all, so anything that isn't pixels means no ceiling.
 */
function maxHeight(textarea: HTMLTextAreaElement): number {
  const computed = window.getComputedStyle(textarea).maxHeight;
  return computed.endsWith("px") ? Number.parseFloat(computed) : Number.POSITIVE_INFINITY;
}

/**
 * Keeps a textarea exactly as tall as its text, so a pane grows instead of scrolling (design D1.4):
 * with no scrollbar and no resize handle, the only way to see all of a long draft is for the frame
 * itself to get taller — up to the ceiling the element's own `max-height` sets, past which it
 * scrolls after all.
 *
 * The box has to be collapsed before measuring — `scrollHeight` of an already-tall textarea reports
 * the height it has, never the smaller height it now needs, so deleting text would never shrink it.
 * jsdom lays nothing out and answers 0: that's the signal to hand the height back to CSS, which
 * keeps the frame's min-height and leaves the tests measuring nothing.
 *
 * The ceiling is read from the computed style rather than written here as a number, so it stays in
 * the class list beside the rest of the layout's numbers (`max-h-[65vh]`) — this hook is about
 * measuring, not about how tall a pane is allowed to get, and a second copy of that decision in
 * TypeScript would be free to drift from the one in the markup. Without it the growth was unbounded:
 * a 4,000-word paste — well inside MAX_SOURCE_LENGTH — grew the box to ~10,000px, the grid stretched
 * the result pane to match, and the gloss picker, the character counter and Update Translation went
 * thousands of pixels below the fold. That is worst exactly when the text is over the limit, because
 * the button is disabled and the one sentence saying why ("Too long to translate — …") is down there
 * with it.
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
    const grown = needed + borders;
    const ceiling = maxHeight(textarea);
    // Below the ceiling there is nothing to scroll, and `overflow-hidden` is what keeps a browser
    // from painting a scrollbar over a box that is already exactly as tall as its text (a
    // sub-pixel row of content is enough to earn one). At the ceiling the opposite is true: the
    // text really is taller than the box, and hidden overflow would make the tail of a long draft
    // unreachable — no scrollbar, no resize handle, no keyboard route to text that isn't painted.
    // So the decision belongs to whoever knows which case this is, and that is this measurement.
    // Written as an inline style it overrides the class only while it must, and clears back to it.
    const clamped = grown > ceiling;
    textarea.style.overflowY = clamped ? "auto" : "";
    textarea.style.height = needed === 0 ? "" : `${clamped ? ceiling : grown}px`;
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
