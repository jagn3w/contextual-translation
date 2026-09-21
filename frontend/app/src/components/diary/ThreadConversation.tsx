import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Language } from "../../gql/graphql.ts";
import { codePointLength } from "../../lib/codePoints.ts";
import { type DiaryThread, MAX_COMMENT_LENGTH } from "../../lib/diary.ts";
import { languageTag } from "../../lib/languages.ts";
import { usePending } from "../../lib/usePending.ts";
import { askingClaude, useElapsedSeconds } from "../../lib/useElapsedSeconds.ts";
import { useAnnounce } from "./announce.ts";

/**
 * What the page can do to a thread. Each returns the mutation's promise, so the component that
 * called it can show its own pending state; `onReply` resolves true once the reply is saved, which
 * is what clears the box (a failure keeps the learner's question in it to try again). Failures are
 * the caller's to report — it has the error, and the toast wording (diaryErrorMessage,
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
  const announce = useAnnounce();
  const lastComment = useRef<HTMLLIElement>(null);
  const commentCount = useRef(thread.comments.length);

  // A reply or hint lands below what the learner was reading, and in the feedback card, which
  // scrolls on its own, past the bottom of it: bring the newest comment into view. Not on first
  // render, which would scroll the page to every thread as it mounts.
  useEffect(() => {
    if (thread.comments.length > commentCount.current) lastComment.current?.scrollIntoView({ block: "nearest" });
    commentCount.current = thread.comments.length;
  }, [thread.comments.length]);

  async function requestHint() {
    announce("Asking Claude…");
    const ok = await runHint(() => actions.onRequestHint(thread.id));
    if (ok === undefined) return; // a second click while the first was out
    announce(ok === false ? "Couldn't get a hint." : "Hint received.");
  }

  const threadButtons = (
    <>
      {thread.kind === "HELP" && !thread.resolved && (
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => void requestHint()}>
          Another hint
        </button>
      )}
      <button
        type="button"
        className={SECONDARY_BUTTON}
        // Not while Claude is answering either: the answer comes back as the whole thread, and
        // resolving under it would leave the one that lands last deciding what the card shows.
        disabled={resolving || busy}
        onClick={() => void runResolve(() => actions.onResolve(thread.id, !thread.resolved))}
      >
        {thread.resolved ? "Reopen" : "Resolve"}
      </button>
    </>
  );

  return (
    <div className="space-y-3">
      {thread.comments.length > 0 && (
        <ol className="space-y-2" lang={languageTag(notesLanguage)}>
          {thread.comments.map((comment, index) => (
            <li
              key={comment.id}
              ref={index === thread.comments.length - 1 ? lastComment : undefined}
              className="scroll-mt-10 text-sm leading-snug"
            >
              <span className="block text-xs font-medium text-muted" lang="en">
                {comment.author === "TUTOR" ? "Claude" : "You"}
              </span>
              <p className="whitespace-pre-wrap text-ink">{comment.body}</p>
            </li>
          ))}
        </ol>
      )}
      {/* Seen, not heard: the diary's live region (useAnnounce) says it to screen readers. */}
      {busy && <p className="text-xs text-muted">{askingClaude(hintElapsed) ?? "Asking Claude…"}</p>}
      {thread.resolved ? (
        <div className="flex flex-wrap items-center gap-2">{threadButtons}</div>
      ) : (
        <ReplyBox
          label={replyLabel}
          disabled={busy}
          extraActions={threadButtons}
          onSend={async (body) => {
            setReplying(true);
            announce("Asking Claude…");
            try {
              const ok = await actions.onReply(thread.id, body);
              announce(ok ? "Reply received." : "Couldn't get a reply.");
              return ok;
            } finally {
              setReplying(false);
            }
          }}
        />
      )}
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
  /** More buttons for the row Send is on, at its start. */
  extraActions?: ReactNode;
};

/** A labelled textarea with a send button; ⌘/Ctrl+Enter sends too, as it does everywhere else. */
export function ReplyBox({ label, disabled, onSend, sendLabel = "Send", placeholder, lang, extraActions }: ReplyBoxProps) {
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
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {extraActions}
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
            {length > MAX_COMMENT_LENGTH * 0.8 &&
              `${length.toLocaleString()} / ${MAX_COMMENT_LENGTH.toLocaleString()}`}
          </span>
          <button type="button" className={SECONDARY_BUTTON} disabled={!canSend} onClick={() => void send()}>
            {sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
