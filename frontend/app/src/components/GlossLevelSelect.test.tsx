import { render, screen } from "@testing-library/react";
import { GlossLevelSelect } from "./GlossLevelSelect.tsx";

/** Same guard as LanguageSelect's, for the same construct: see the note there. */
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

describe("GlossLevelSelect", () => {
  it("renders without React logging a single error", () => {
    withoutConsoleErrors(() => {
      render(<GlossLevelSelect value="NOTABLE" onChange={() => undefined} />);
    });
  });

  it("shows the current level, truncated, inside the trigger", () => {
    render(<GlossLevelSelect value="NOTABLE" onChange={() => undefined} />);

    const trigger = screen.getByLabelText("Definitions");
    const truncating = trigger.querySelector(".truncate");

    expect(truncating).not.toBeNull();
    expect(truncating).toHaveTextContent("Definitions: Notable");
  });

  it("wears the shared focus indicator rather than an invisible tint of its own", () => {
    render(<GlossLevelSelect value="NOTABLE" onChange={() => undefined} />);

    const trigger = screen.getByLabelText("Definitions");

    expect(trigger).toHaveClass("focus-ring");
    expect(trigger.className).not.toMatch(/ring-accent/);
  });
});
