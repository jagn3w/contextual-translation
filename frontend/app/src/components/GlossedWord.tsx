import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { type PointerEvent as ReactPointerEvent, type ReactNode, useRef, useState } from "react";
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
 * How far the pointer may travel between press and release and still count as a tap. Past it the
 * gesture was a drag — a selection — and the word must not answer it by opening a card.
 */
const TAP_SLOP = 6;

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
 *
 * The translation stays selectable through all of that, because reading it is not the only thing
 * people do with it — they copy it out. A `<button>` fights that twice over: a UA stylesheet
 * hands a control `user-select: none`, so a drag across the sentence skips the glossed words,
 * and a drag that begins and ends on one still fires a click, so finishing the selection pops a
 * card open and takes the focus with it. Hence `select-text` and the slop check below.
 */
export function GlossedWord({ gloss, children }: Props) {
  const [hovered, setHovered] = useState(false);
  const [tapped, setTapped] = useState(false);
  // Where the pointer went down on this word, and whether it had moved far enough by the time it
  // came up to have been selecting rather than tapping.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    pressedAt.current = { x: event.clientX, y: event.clientY };
    dragged.current = false;
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const from = pressedAt.current;
    pressedAt.current = null;
    dragged.current =
      from !== null && Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP;
  }

  // Radix asks to open; a drag is the one request that gets refused, and only once — the flag is
  // spent here so the next press (or the keyboard, which never sets it) opens normally. Closing
  // always goes through, so a card already open still dismisses on an outside click.
  function handleOpenChange(open: boolean) {
    if (open && dragged.current) {
      dragged.current = false;
      return;
    }
    setTapped(open);
  }

  return (
    <Popover.Root open={tapped} onOpenChange={handleOpenChange}>
      <Tooltip.Root open={hovered && !tapped} onOpenChange={setHovered}>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>
            {/* `inline` (not the UA's inline-block) keeps the word inside the paragraph's line
                box, so a `<ruby>` within it still sits under its reading and the surrounding
                `whitespace-pre-wrap` text wraps through it as if it were plain text. Preflight
                already hands a button the surrounding type and a transparent background; what is
                left of the control — its platform appearance, its centred text and its
                unselectable label — is undone here, so the only affordance is the dotted underline
                (and the ring, for the keyboard).

                That underline is the sole mark saying this word has a definition, which makes it a
                non-text UI indicator under WCAG 1.4.11 and puts it to a 3:1 minimum against the
                ground behind it. At 80% --color-frame-muted composites to 4.0:1 on --color-frame
                and 3.7:1 on --color-frame-stale, clear on both; the /50 it replaces was 2.2:1 and
                2.1:1, the only new affordance on this branch to skip the check index.css records
                for its other tokens.

                `aria-label` because the accessible name would otherwise be the text content, and
                for Japanese that folds each `<rt>` in: "天気てんき, button". `select-none` styles
                the readings out of a copy but says nothing about the name. The word alone is the
                name; the reading is on the card, which shows it beside the word. */}
            <button
              type="button"
              aria-label={gloss.text}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              className="inline cursor-help select-text appearance-none rounded-[2px] text-left underline decoration-frame-muted/80 decoration-dotted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
