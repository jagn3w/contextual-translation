/// <reference types="node" />
// The app's tsconfig lists `types` explicitly and leaves @types/node out — browser code has no
// business typechecking `process` — so the one test that reads a file off disk asks for the Node
// declarations here rather than widening the config for everybody. Nothing but this file imports
// them, and vitest runs it in Node regardless of the jsdom document it also gets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The palette is the one place in the app where a WCAG number is a *property of the source*, not
 * of a rendered page: the tokens are hex, the backdrops are hex, and the ratio between them is
 * arithmetic. index.css records those ratios in prose beside each token; this recomputes them, so
 * the prose cannot quietly stop being true — which is exactly how the focus ring ended up at
 * 1.45:1 on a branch whose whole point was contrast.
 *
 * What it can't check is which backdrop a control actually sits on, or that the indicator is drawn
 * at all. Those stay the comments' job, and a browser's.
 *
 * Read off disk rather than imported: vitest is configured `css: false`, which makes a stylesheet
 * import — `?raw` included — resolve to an empty string. The sibling path is spelled by hand
 * because Vite rewrites `new URL("./x", import.meta.url)` into an asset reference before the test
 * ever runs, which is not a file path.
 */
const CSS = readFileSync(fileURLToPath(import.meta.url).replace(/[^/\\]+$/, "index.css"), "utf8");


/** A `--name: value;` declaration from the @theme block, following one level of `var()` alias. */
function token(name: string): string {
  const declared = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS)?.[1]?.trim();
  if (declared === undefined) throw new Error(`index.css declares no --${name}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(declared)?.[1];
  return alias === undefined ? declared : token(alias);
}

/** WCAG relative luminance of an `#rrggbb` token: sRGB channels linearised, then weighted. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match?.[1] === undefined) throw new Error(`not a six-digit hex colour: ${hex}`);
  const channels = [0, 2, 4].map((at) => Number.parseInt(match[1]!.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast between two opaque colours, 1:1 to 21:1. */
function contrast(a: string, b: string): number {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("palette contrast", () => {
  it("draws the focus indicator at 3:1 or better on every backdrop a control sits on", () => {
    // WCAG 1.4.11 (non-text contrast) and 2.4.11 (focus appearance). The backdrops: the page is
    // --color-canvas, every one of these controls tints to --color-surface on hover, and
    // --color-frame is the result pane a control could be placed in next.
    const focus = token("color-focus");

    for (const backdrop of ["color-canvas", "color-surface", "color-frame"]) {
      expect(contrast(focus, token(backdrop)), `focus on --${backdrop}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("agrees with the ratios index.css writes down beside its text tokens", () => {
    // A spot check that the recorded numbers are the computed ones, so a token can't be nudged
    // while its comment keeps quoting the old figure.
    expect(contrast(token("color-ink"), token("color-frame-stale"))).toBeCloseTo(9.6, 1);
    expect(contrast(token("color-frame-muted"), token("color-frame-stale"))).toBeCloseTo(5.7, 1);
    expect(contrast(token("color-frame-muted"), token("color-frame"))).toBeCloseTo(6.3, 1);
    expect(contrast(token("color-muted"), token("color-frame"))).toBeCloseTo(3.9, 1);
  });

  it("keeps the learner's words readable on every diary verdict highlight, and its underline visible", () => {
    // The ink is text (4.5:1); the frame-muted underline is the non-colour verdict cue (3:1).
    const recorded: Record<string, number> = {
      "color-verdict-wrong": 10.0,
      "color-verdict-wrong-open": 8.0,
      "color-verdict-improvable": 10.5,
      "color-verdict-improvable-open": 8.9,
      "color-verdict-correct": 10.1,
      "color-verdict-correct-open": 8.5,
    };
    for (const [name, ratio] of Object.entries(recorded)) {
      const ground = token(name);
      expect(contrast(token("color-ink"), ground), `ink on --${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("color-ink"), ground), `ink on --${name}`).toBeCloseTo(ratio, 1);
      expect(contrast(token("color-frame-muted"), ground), `underline on --${name}`).toBeGreaterThanOrEqual(3);
    }
  });
});
