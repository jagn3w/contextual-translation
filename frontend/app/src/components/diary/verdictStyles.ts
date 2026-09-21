import type { DiaryVerdict } from "../../lib/diary.ts";

/**
 * How each verdict is drawn over the learner's text. Two cues, so neither carries the meaning
 * alone (WCAG 1.4.1): the wash colour, and an underline style of its own — wavy for "needs
 * fixing", as a spellchecker marks a mistake; dashed for "could be better"; solid for "natural".
 * Written out in full so Tailwind's scanner can see every class. Contrast ratios are in index.css.
 */
export const VERDICT_STYLE: Record<DiaryVerdict, { wash: string; open: string; underline: string; swatch: string }> = {
  WRONG: {
    wash: "bg-verdict-wrong",
    open: "bg-verdict-wrong-open",
    underline: "decoration-wavy",
    swatch: "bg-verdict-wrong-open",
  },
  IMPROVABLE: {
    wash: "bg-verdict-improvable",
    open: "bg-verdict-improvable-open",
    underline: "decoration-dashed",
    swatch: "bg-verdict-improvable-open",
  },
  CORRECT: {
    wash: "bg-verdict-correct",
    open: "bg-verdict-correct-open",
    underline: "decoration-solid",
    swatch: "bg-verdict-correct-open",
  },
};

/** The order the legend lists them in: what most needs attention first. */
export const VERDICTS: readonly DiaryVerdict[] = ["WRONG", "IMPROVABLE", "CORRECT"];
