import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { toast } from "sonner";
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
  // Module state: a draft one test left unsaved must not seed the next test's entry, and a toast
  // one test raised on purpose stays in sonner's store and would show in the next test's Toaster.
  forgetDrafts();
  toast.dismiss();
});
