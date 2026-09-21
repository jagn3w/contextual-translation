import * as Popover from "@radix-ui/react-popover";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { Language } from "../../gql/graphql.ts";
import { type DiaryThread, type DiaryVerdict, verdictLabel } from "../../lib/diary.ts";
import { type ThreadActions, ThreadConversation } from "./ThreadConversation.tsx";
import { VERDICT_STYLE } from "./verdictStyles.ts";

type Props = {
  thread: DiaryThread & { verdict: DiaryVerdict };
  text: string;
  actions: ThreadActions;
  notesLanguage: Language;
};

/** As in GlossedWord: past this many px between press and release, the gesture was a selection. */
const TAP_SLOP = 6;

/** The verdict in words beside its swatch — the card's heading, and the legend's entries. */
export function VerdictBadge({ verdict, resolved = false }: { verdict: DiaryVerdict; resolved?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
      <span aria-hidden className={`inline-block size-2.5 rounded-sm ${VERDICT_STYLE[verdict].swatch}`} />
      {verdictLabel(verdict)}
      {resolved && <span className="font-normal text-muted">· Resolved</span>}
    </span>
  );
}

/**
 * One reviewed sentence in the feedback view: its verdict's wash and underline, and a card with
 * the thread when it is clicked, tapped or activated from the keyboard.
 *
 * A Popover alone, where GlossedWord pairs one with a Tooltip: this card is somewhere to work — a
 * question to type, a thread to resolve — not a definition to skim, so opening it is always a
 * deliberate act and hovering does nothing. The rest is GlossedWord's reasoning, for the same
 * reasons: an inline `<button>` so the sentence stays in the paragraph's line box and reachable by
 * Tab and Enter; `select-text` so a drag across the entry copies these sentences too; and the slop
 * check so the release that ends a drag-selection doesn't open a card and steal the focus.
 *
 * A resolved thread loses its wash, as the design asks, but keeps a quiet dotted underline and its
 * button: it can still be opened, read and reopened.
 */
export function SentenceHighlight({ thread, text, actions, notesLanguage }: Props) {
  const [open, setOpen] = useState(false);
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const style = VERDICT_STYLE[thread.verdict];
  const label = verdictLabel(thread.verdict);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    pressedAt.current = { x: event.clientX, y: event.clientY };
    dragged.current = false;
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const from = pressedAt.current;
    pressedAt.current = null;
    dragged.current = from !== null && Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP;
  }

  function handleOpenChange(next: boolean) {
    if (next && dragged.current) {
      dragged.current = false;
      return;
    }
    setOpen(next);
  }

  const look = thread.resolved
    ? "decoration-dotted decoration-muted"
    : `${open ? style.open : style.wash} ${style.underline} decoration-frame-muted`;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        {/* The accessible name leads with the verdict, which the colour and the underline can't
            say to a screen reader; the sentence follows so each highlight is told apart.
            `box-decoration-clone` gives a sentence that wraps its wash and rounding on every line. */}
        <button
          type="button"
          aria-label={thread.resolved ? `${label}, resolved: ${text}` : `${label}: ${text}`}
          data-verdict={thread.verdict}
          data-resolved={thread.resolved || undefined}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className={`focus-ring inline cursor-pointer select-text appearance-none rounded-[3px] text-left underline underline-offset-4 box-decoration-clone ${look}`}
        >
          {text}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`Feedback: ${label}`}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-canvas p-3 text-left shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <VerdictBadge verdict={thread.verdict} resolved={thread.resolved} />
            <Popover.Close aria-label="Close" className="focus-ring rounded-md px-1.5 text-muted hover:bg-surface hover:text-ink">
              ×
            </Popover.Close>
          </div>
          <ThreadConversation thread={thread} actions={actions} notesLanguage={notesLanguage} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
