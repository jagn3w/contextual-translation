import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { forgetDrafts } from "../lib/unsavedDrafts.ts";

// jsdom lacks the pointer-capture and scrolling APIs Radix primitives call.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
});

afterEach(() => {
  cleanup();
  // Module state, like sonner's: a draft one test left unsaved must not seed the next test's entry.
  forgetDrafts();
});
