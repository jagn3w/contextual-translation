import { render, screen } from "@testing-library/react";
import { LanguageSelect } from "./LanguageSelect.tsx";

/**
 * React reports a bad render — a prop that can't be applied, a ref that went nowhere — by writing
 * to `console.error` and carrying on, and vitest does not fail on that. So the spy is the only
 * thing standing between "the component renders" and "the component renders correctly": without
 * it, `<Select.Value asChild>` slotting onto Radix's internal Fragment passed every test in the
 * suite while dropping Radix's style and its onValueNodeChange ref on the floor.
 */
function withoutConsoleErrors(body: () => void) {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  try {
    body();
  } finally {
    spy.mockRestore();
  }
  expect(errors).toEqual([]);
}

describe("LanguageSelect", () => {
  it("renders without React logging a single error", () => {
    // `<Select.Value asChild>` logged "Invalid prop `style` supplied to `React.Fragment`" four
    // times a render: Radix renders SelectValue as Primitive.span over a Fragment, so the Slot
    // cloned the Fragment rather than our span and both Radix's style and its ref went nowhere.
    withoutConsoleErrors(() => {
      render(<LanguageSelect label="Target language" value="JA" onChange={() => undefined} />);
    });
  });

  it("shows the selected language, truncated, inside the trigger", () => {
    // The truncation is the thing the broken `asChild` happened to preserve by accident, so it is
    // asserted here rather than left to the render test: the span has to be a real element with
    // the class on it, not a Fragment whose children merely reached the DOM.
    render(<LanguageSelect label="Target language" value="JA" onChange={() => undefined} />);

    const trigger = screen.getByLabelText("Target language");
    const truncating = trigger.querySelector(".truncate");

    expect(truncating).not.toBeNull();
    expect(truncating).toHaveTextContent("Japanese");
  });

  it("wears the shared focus indicator rather than an invisible tint of its own", () => {
    // focus-visible:ring-accent/30 composited to 1.45:1 on the canvas, where WCAG 1.4.11/2.4.11
    // ask 3:1 of a focus indicator — a ring only keyboard users ever see, and none of them could.
    // The ratios for `focus-ring` are computed and recorded in index.css.
    render(<LanguageSelect label="Target language" value="JA" onChange={() => undefined} />);

    const trigger = screen.getByLabelText("Target language");

    expect(trigger).toHaveClass("focus-ring");
    expect(trigger.className).not.toMatch(/ring-accent/);
  });
});
