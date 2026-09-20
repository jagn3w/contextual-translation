import { render, screen } from "@testing-library/react";
import { useAutoGrowTextarea } from "./useAutoGrowTextarea.ts";

/** One line of the fake layout below, in px. */
const LINE = 20;

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
      return Math.max(box, this.value.split("\n").length * LINE);
    },
  });
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
  afterEach(restoreScrollHeight);

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

  it("hands the height back to CSS where nothing is laid out", () => {
    // The fallback case, which is what the tests in this suite otherwise run under: jsdom lays
    // nothing out and answers 0, and 0px would collapse the frame's min-height to nothing.
    render(<Grower value={"one\ntwo\nthree"} />);

    expect(box()).toBe("");
  });
});
