import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { type ReactNode, useState } from "react";
import type { Gloss } from "../lib/annotateTranslation.ts";

type Props = {
  gloss: Gloss;
  children: ReactNode;
};

/**
 * The definition card, identical in both surfaces below: the word, its reading where there is one
 * (Japanese), and the short meaning the backend wrote in the source text's language.
 */
function GlossCard({ gloss }: { gloss: Gloss }) {
  return (
    <>
      <p className="text-sm font-medium text-ink">
        {gloss.text}
        {gloss.reading !== null && gloss.reading !== "" && (
          <span className="ml-2 text-xs font-normal text-muted">{gloss.reading}</span>
        )}
      </p>
      <p className="mt-1 text-sm leading-snug text-frame-muted">{gloss.meaning}</p>
    </>
  );
}

/** The card's frame, shared so the hovered and the tapped definition look like the same object. */
const CARD = "z-50 max-w-64 rounded-lg border border-line bg-canvas px-3 py-2 text-left shadow-lg";

/**
 * One glossed word of the translation (design D2.3): a quiet dotted underline that shows the
 * definition on hover, on keyboard focus, and on a tap.
 *
 * Two Radix primitives on one trigger, because neither covers every input on its own: Tooltip
 * deliberately ignores touch (a tap has no hover to describe), and Popover deliberately ignores
 * hover. Nesting them — Tooltip outside, the Popover trigger *being* the button — gives pointer
 * and keyboard users an instant, dismissable tooltip and touch users a card that stays put. The
 * tooltip is controlled so opening the popover closes it: otherwise the tap would leave a tooltip
 * sitting behind the card it just opened.
 */
export function GlossedWord({ gloss, children }: Props) {
  const [hovered, setHovered] = useState(false);
  const [tapped, setTapped] = useState(false);

  return (
    <Popover.Root open={tapped} onOpenChange={setTapped}>
      <Tooltip.Root open={hovered && !tapped} onOpenChange={setHovered}>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>
            {/* `inline` (not the UA's inline-block) keeps the word inside the paragraph's line
                box, so a `<ruby>` within it still sits under its reading and the surrounding
                `whitespace-pre-wrap` text wraps through it as if it were plain text. Preflight
                already hands a button the surrounding type and a transparent background; what is
                left of the control — its platform appearance and its centred text — goes here, so
                the only affordance is the dotted underline (and the ring, for the keyboard). */}
            <button
              type="button"
              className="inline cursor-help appearance-none rounded-[2px] text-left underline decoration-frame-muted/50 decoration-dotted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {children}
            </button>
          </Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className={CARD}>
            <GlossCard gloss={gloss} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={6} collisionPadding={8} className={CARD}>
          <GlossCard gloss={gloss} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
