import { type KeyboardEvent, useId, useState } from "react";
import type { Language } from "../../gql/graphql.ts";
import { codePointLength } from "../../lib/codePoints.ts";
import { type DiaryThread, MAX_COMMENT_LENGTH } from "../../lib/diary.ts";
import { languageTag } from "../../lib/languages.ts";
import { usePending } from "../../lib/usePending.ts";
import { askingClaude, useElapsedSeconds } from "../../lib/useElapsedSeconds.ts";

/**
 * What the page can do to a thread. Each returns the mutation's promise, so the component that
 * called it can show its own pending state; `onReply` resolves true once the reply is saved, which
 * is what clears the box (a failure keeps the learner's question in it to try again). Failures are
 * the caller's to report — it has the error, and the toast wording (translateErrorMessage,
 * failureMessage) lives with it.
 */
export type ThreadActions = {
  onReply: (threadId: string, body: string) => Promise<boolean>;
  onResolve: (threadId: string, resolved: boolean) => Promise<unknown>;
  onRequestHint: (threadId: string) => Promise<unknown>;
};

type Props = {
  thread: DiaryThread;
  actions: ThreadActions;
  /** The learner's own language: Claude's comments are written in it. */
  notesLanguage: Language;
  replyLabel?: string;
};

export const SECONDARY_BUTTON =
  "focus-ring rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40";
export const PRIMARY_BUTTON =
  "focus-ring rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * A thread's comments and everything the learner can do with it: ask a follow-up, ask for another
 * hint (HELP threads), resolve or reopen. The same body serves the sentence card, the help threads,
 * the entry-wide notes and the earlier feedback, so a thread behaves the same wherever it is read.
 */
export function ThreadConversation({ thread, actions, notesLanguage, replyLabel = "Ask a question about this" }: Props) {
  const [hinting, runHint] = usePending();
  const [resolving, runResolve] = usePending();
  const [replying, setReplying] = useState(false);
  const hintElapsed = useElapsedSeconds(hinting || replying);
  const busy = hinting || replying;

  return (
    <div className="space-y-3">
      {thread.comments.length > 0 && (
        <ol className="space-y-2" lang={languageTag(notesLanguage)}>
          {thread.comments.map((comment) => (
            <li key={comment.id} className="text-sm leading-snug">
              <span className="block text-xs font-medium text-muted" lang="en">
                {comment.author === "TUTOR" ? "Claude" : "You"}
              </span>
              <p className="whitespace-pre-wrap text-ink">{comment.body}</p>
            </li>
          ))}
        </ol>
      )}
      {busy && (
        <p className="text-xs text-muted" role="status">
          {askingClaude(hintElapsed) ?? "Asking Claude…"}
        </p>
      )}
      {!thread.resolved && (
        <ReplyBox
          label={replyLabel}
          disabled={busy}
          onSend={async (body) => {
            setReplying(true);
            try {
              return await actions.onReply(thread.id, body);
            } finally {
              setReplying(false);
            }
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {thread.kind === "HELP" && !thread.resolved && (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={busy}
            onClick={() => void runHint(() => actions.onRequestHint(thread.id))}
          >
            Another hint
          </button>
        )}
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={resolving}
          onClick={() => void runResolve(() => actions.onResolve(thread.id, !thread.resolved))}
        >
          {thread.resolved ? "Reopen" : "Resolve"}
        </button>
      </div>
    </div>
  );
}

type ReplyBoxProps = {
  label: string;
  disabled: boolean;
  /** Resolves true when the text was accepted, which clears the box. */
  onSend: (body: string) => Promise<boolean>;
  sendLabel?: string;
  placeholder?: string | undefined;
  lang?: string | undefined;
};

/** A labelled textarea with a send button; ⌘/Ctrl+Enter sends too, as it does everywhere else. */
export function ReplyBox({ label, disabled, onSend, sendLabel = "Send", placeholder, lang }: ReplyBoxProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, run] = usePending();
  const length = codePointLength(text);
  const tooLong = length > MAX_COMMENT_LENGTH;
  const canSend = !disabled && !sending && text.trim() !== "" && !tooLong;

  async function send() {
    if (!canSend) return;
    const sent = text;
    const ok = await run(() => onSend(sent));
    // Only clear what was sent: anything typed while the request was out stays.
    if (ok === true) setText((current) => (current === sent ? "" : current));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      // Handled here: the entry's own ⌘/Ctrl+Enter (Get feedback) must not also fire, and React
      // bubbles through the popover's portal to it.
      event.stopPropagation();
      void send();
    }
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-muted">
        {label}
      </label>
      <textarea
        id={id}
        value={text}
        rows={2}
        lang={lang}
        placeholder={placeholder}
        aria-invalid={tooLong}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        className="focus-ring mt-1 block w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm leading-snug placeholder:text-muted/60"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
          {length > MAX_COMMENT_LENGTH * 0.8 &&
            `${length.toLocaleString()} / ${MAX_COMMENT_LENGTH.toLocaleString()}`}
        </span>
        <button type="button" className={SECONDARY_BUTTON} disabled={!canSend} onClick={() => void send()}>
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
