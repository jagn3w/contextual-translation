import { render, screen } from "@testing-library/react";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea.ts";

/** One line of the fake layout below, in px. */
const LINE = 20;

/**
 * How many lines the fake layout wraps each line of the value into: 1 in a wide enough column, 2
 * once something has narrowed it. This is the thing no keystroke changes, so only a re-measure
 * driven by the column itself can pick it up.
 */
let wrap = 1;

/**
 * A browser's `scrollHeight`, which jsdom never computes: the taller of the box the element
 * currently has and the content it holds. That "taller of" is the whole point — an already-tall
 * textarea reports the height it *has*, not the smaller one it now needs, so a hook that measures
 * without collapsing the box first can only ever grow. The getter reads `style.height` so the
 * collapse to `auto` the hook performs is what the measurement actually sees.
 */
function stubScrollHeight() {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement): number {
      const height = this.style.height;
      const box = height === "" || height === "auto" ? 0 : Number.parseFloat(height);
      return Math.max(box, this.value.split("\n").length * wrap * LINE);
    },
  });
}

/**
 * The seam for the element observer: jsdom implements no ResizeObserver at all, so the hook's
 * guard would otherwise skip it and there would be nothing to drive. The stub keeps the callbacks
 * registered against an observed element and hands back a way to deliver one, which is what a
 * browser does when the column narrows — including for the case no window `resize` covers, the
 * document's scrollbar appearing.
 */
function stubResizeObserver() {
  const callbacks: Array<() => void> = [];
  class FakeResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe() {
      callbacks.push(this.callback);
    }
    disconnect() {
      const at = callbacks.indexOf(this.callback);
      if (at !== -1) callbacks.splice(at, 1);
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return { resize: () => callbacks.forEach((fire) => fire()), observing: () => callbacks.length };
}

/**
 * Hands `scrollHeight` back to jsdom, which answers 0 for everything. Deleting the own property
 * uncovers the inherited one on Element.prototype; `scrollHeight` is declared readonly, so the
 * delete goes through a plain record view of the prototype object.
 */
function restoreScrollHeight() {
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)["scrollHeight"];
}

function Grower({ value }: { value: string }) {
  const ref = useAutoGrowTextarea(value);
  return <textarea ref={ref} value={value} readOnly aria-label="Grower" />;
}

const box = () => screen.getByLabelText<HTMLTextAreaElement>("Grower").style.height;

describe("useAutoGrowTextarea", () => {
  afterEach(() => {
    restoreScrollHeight();
    wrap = 1;
    vi.unstubAllGlobals();
  });

  it("grows the box to fit the text", () => {
    stubScrollHeight();
    const { rerender } = render(<Grower value="one line" />);
    expect(box()).toBe(`${LINE}px`);

    rerender(<Grower value={"one\ntwo\nthree\nfour\nfive"} />);

    expect(box()).toBe(`${5 * LINE}px`);
  });

  it("shrinks the box again when the text goes away", () => {
    // The invariant the hook is built around: without collapsing to `auto` before measuring, the
    // box would still report five lines' worth of height and would never come back down.
    stubScrollHeight();
    const { rerender } = render(<Grower value={"one\ntwo\nthree\nfour\nfive"} />);
    expect(box()).toBe(`${5 * LINE}px`);

    rerender(<Grower value="one line" />);

    expect(box()).toBe(`${LINE}px`);
  });

  it("re-measures when the element's own box changes, not only when the window does", () => {
    // The column narrowing is not a window resize: the document's scrollbar appearing takes ~15px
    // off it and fires no resize event at all. Nothing else re-measures until the next keystroke,
    // and in a box with no scrollbar and no resize handle the stale height clips the text for good.
    const observer = stubResizeObserver();
    stubScrollHeight();
    render(<Grower value={"one\ntwo"} />);
    expect(box()).toBe(`${2 * LINE}px`);

    wrap = 2;
    observer.resize();

    expect(box()).toBe(`${4 * LINE}px`);
  });

  it("stops observing when the textarea goes away", () => {
    const observer = stubResizeObserver();
    stubScrollHeight();
    const { unmount } = render(<Grower value={"one\ntwo"} />);
    expect(observer.observing()).toBe(1);

    unmount();

    // An observer left connected would go on measuring a detached element on every layout change
    // for as long as the page lives — and keeps the element itself alive to do it.
    expect(observer.observing()).toBe(0);
  });

  it("hands the height back to CSS where nothing is laid out", () => {
    // The fallback case, which is what the tests in this suite otherwise run under: jsdom lays
    // nothing out and answers 0, and 0px would collapse the frame's min-height to nothing.
    render(<Grower value={"one\ntwo\nthree"} />);

    expect(box()).toBe("");
  });
});
