import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { Language } from "../../gql/graphql.ts";
import { codePointLength } from "../../lib/codePoints.ts";
import { type DiaryEntry, formatDateTime, MAX_BODY_LENGTH } from "../../lib/diary.ts";
import { languageName, languageTag } from "../../lib/languages.ts";
import { type SaveState } from "../../lib/useAutosave.ts";
import { useAutoGrowTextarea } from "../../lib/useAutoGrowTextarea.ts";
import { askingClaude, useElapsedSeconds } from "../../lib/useElapsedSeconds.ts";
import { usePending } from "../../lib/usePending.ts";
import { LanguageSelect } from "../LanguageSelect.tsx";
import { FeedbackView } from "./FeedbackView.tsx";
import { PRIMARY_BUTTON, SECONDARY_BUTTON, type ThreadActions } from "./ThreadConversation.tsx";

type Props = {
  entry: DiaryEntry;
  body: string;
  onBodyChange: (body: string) => void;
  saveState: SaveState;
  /** Saves `body` and asks for a review; resolves true when the review came back. */
  onRequestFeedback: (body: string) => Promise<boolean>;
  /** Absent when the languages can't be changed; offered only while the entry is still empty. */
  onChangeLanguages?: ((language: Language, notesLanguage: Language) => Promise<unknown>) | undefined;
  /** Deletes the entry; resolves true once it's gone. Asked for only after a confirmation. */
  onDelete: () => Promise<boolean>;
  actions: ThreadActions;
};

type Mode = "write" | "feedback";

const SAVE_TEXT: Record<SaveState, string> = { idle: "", saving: "Saving…", saved: "Saved", error: "Not saved" };

/**
 * One entry: its date and languages, the Write and Feedback modes, and Get feedback. It opens in
 * Feedback when there is feedback on the text as it stands, and in Write otherwise; a review that
 * comes back switches to Feedback, which is where its answer is.
 */
export function EntryEditor({
  entry,
  body,
  onBodyChange,
  saveState,
  onRequestFeedback,
  onChangeLanguages,
  onDelete,
  actions,
}: Props) {
  const bodyId = useId();
  const [mode, setMode] = useState<Mode>(
    entry.reviewedBody !== null && entry.reviewedBody === body ? "feedback" : "write",
  );
  const [reviewing, runReview] = usePending();
  const elapsed = useElapsedSeconds(reviewing);
  const textareaRef = useAutoGrowTextarea(body);
  const length = codePointLength(body);
  const tooLong = length > MAX_BODY_LENGTH;
  const canReview = !reviewing && body.trim() !== "" && !tooLong;
  // Languages are chosen before anything is written: the feedback and the hints are all about
  // text in one language, so changing it under existing words would make nonsense of them.
  const changeLanguages = body === "" && entry.reviewedBody === null ? onChangeLanguages : undefined;
  const reviewedBody = entry.reviewedBody;

  async function requestFeedback() {
    if (!canReview) return;
    const ok = await runReview(() => onRequestFeedback(body));
    if (ok === true) setMode("feedback");
  }

  function handleShortcut(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void requestFeedback();
    }
  }

  return (
    <article onKeyDown={handleShortcut} aria-labelledby={`${bodyId}-title`}>
      <header className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id={`${bodyId}-title`} className="text-lg font-semibold tracking-tight">
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </h2>
          <DeleteControl onDelete={onDelete} />
        </div>
        {changeLanguages !== undefined ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-sm text-muted">
            Writing in
            <LanguageSelect
              label="Writing in"
              value={entry.language}
              onChange={(language) =>
                void changeLanguages(
                  language,
                  // One language twice is refused, so picking the other side's swaps them, as
                  // the Phrases pickers do.
                  language === entry.notesLanguage ? entry.language : entry.notesLanguage,
                )
              }
            />
            · notes in
            <LanguageSelect
              label="Notes in"
              value={entry.notesLanguage}
              onChange={(notesLanguage) =>
                void changeLanguages(notesLanguage === entry.language ? entry.notesLanguage : entry.language, notesLanguage)
              }
            />
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">
            Writing in {languageName(entry.language)} · notes in {languageName(entry.notesLanguage)}
          </p>
        )}
      </header>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-line p-0.5" role="group" aria-label="Mode">
          {(["write", "feedback"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              disabled={option === "feedback" && reviewedBody === null}
              onClick={() => setMode(option)}
              className="focus-ring rounded px-3 py-1 text-sm text-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-surface aria-pressed:font-medium aria-pressed:text-ink"
            >
              {option === "write" ? "Write" : "Feedback"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">{askingClaude(elapsed) ?? "⌘/Ctrl + Enter"}</span>
          <button type="button" className={PRIMARY_BUTTON} disabled={!canReview} onClick={() => void requestFeedback()}>
            {reviewing ? "Getting feedback…" : "Get feedback"}
          </button>
        </div>
      </div>

      {mode === "feedback" && reviewedBody !== null ? (
        <FeedbackView entry={{ ...entry, reviewedBody }} body={body} actions={actions} />
      ) : (
        <div>
          <label htmlFor={bodyId} className="sr-only">
            Diary entry
          </label>
          <textarea
            id={bodyId}
            ref={textareaRef}
            value={body}
            lang={languageTag(entry.language)}
            onChange={(event) => onBodyChange(event.target.value)}
            aria-invalid={tooLong}
            placeholder={`Write about your day in ${languageName(entry.language)}…`}
            className="focus-ring block max-h-[70vh] min-h-72 w-full resize-none overflow-hidden rounded-lg border border-line bg-canvas px-4 py-3 text-lg leading-relaxed placeholder:text-muted/60"
          />
          <div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
            <span className={saveState === "error" ? "text-danger" : "text-muted"}>{SAVE_TEXT[saveState]}</span>
            <span className={tooLong ? "text-danger" : "text-muted"}>
              {tooLong && "Too long for feedback — "}
              {length.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * Delete, behind a confirmation: an entry takes its feedback and threads with it and there is no
 * undo. The confirmation takes the focus when it appears, on Cancel, so a stray Enter keeps the entry.
 */
function DeleteControl({ onDelete }: { onDelete: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, run] = usePending();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="focus-ring rounded-md px-2 py-1 text-xs text-muted hover:bg-surface hover:text-ink"
      >
        Delete entry
      </button>
    );
  }
  return (
    <div role="group" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink">Delete this entry and its feedback?</span>
      <button
        type="button"
        disabled={deleting}
        onClick={() => void run(onDelete)}
        // Not white on --color-danger: that is 4.3:1, under AA for text this size. The sentence
        // beside it says what the button does.
        className={SECONDARY_BUTTON}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
      <button ref={cancelRef} type="button" className={SECONDARY_BUTTON} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}
