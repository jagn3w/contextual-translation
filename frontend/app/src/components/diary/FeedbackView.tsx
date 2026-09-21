import { Fragment, type Ref, useMemo } from "react";
import { type DiaryEntry, type DiaryThread, type DiaryVerdict, feedbackRuns, unplacedSentenceThreads } from "../../lib/diary.ts";
import { languageTag } from "../../lib/languages.ts";
import { SentenceHighlight, VerdictBadge } from "./SentenceHighlight.tsx";
import { type ThreadActions, ThreadConversation } from "./ThreadConversation.tsx";
import { VERDICTS } from "./verdictStyles.ts";

type Props = {
  entry: DiaryEntry & { reviewedBody: string };
  /** The text in the editor now, which may be ahead of what was reviewed. */
  body: string;
  actions: ThreadActions;
  /** The view itself, focusable from script: where the focus goes when a review lands. */
  ref?: Ref<HTMLElement>;
};

function hasVerdict(thread: DiaryThread): thread is DiaryThread & { verdict: DiaryVerdict } {
  return thread.verdict !== null;
}

/**
 * The entry as Claude reviewed it, read-only, with each current sentence verdict drawn over it.
 * It shows `reviewedBody`, not the draft: the spans are offsets into the reviewed text and mean
 * nothing over any other, so when the two differ this says so instead of painting stale highlights
 * over new words.
 */
export function FeedbackView({ entry, body, actions, ref }: Props) {
  const runs = useMemo(() => feedbackRuns(entry.reviewedBody, entry.threads), [entry.reviewedBody, entry.threads]);
  const unplaced = useMemo(
    () => unplacedSentenceThreads(entry.reviewedBody, entry.threads).filter(hasVerdict),
    [entry.reviewedBody, entry.threads],
  );
  const edited = body !== entry.reviewedBody;

  return (
    <section ref={ref} tabIndex={-1} aria-label="Claude's feedback" className="outline-none">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1" aria-label="Legend" role="group">
        {VERDICTS.map((verdict) => (
          <VerdictBadge key={verdict} verdict={verdict} />
        ))}
        <span className="text-xs text-muted">Select a sentence to see Claude's tip.</span>
      </div>
      {edited && (
        <p className="mb-3 rounded-md bg-surface px-3 py-2 text-xs text-muted">
          <span className="font-medium text-ink">Edited since this feedback.</span> This is the text Claude reviewed;
          get feedback again to review your changes.
        </p>
      )}
      <p className="whitespace-pre-wrap text-lg leading-loose" lang={languageTag(entry.language)}>
        {runs.map((run, index) =>
          run.thread === undefined || !hasVerdict(run.thread) ? (
            // Runs are a pure function of one review, so the index is a stable identity.
            <Fragment key={index}>{run.text}</Fragment>
          ) : (
            <SentenceHighlight
              key={run.thread.id}
              thread={run.thread}
              text={run.text}
              actions={actions}
              notesLanguage={entry.notesLanguage}
            />
          ),
        )}
      </p>
      {unplaced.length > 0 && (
        <section className="mt-6 border-t border-line pt-4" aria-labelledby={`unplaced-${entry.id}`}>
          <h3 id={`unplaced-${entry.id}`} className="text-sm font-medium">
            Also reviewed
          </h3>
          <p className="text-xs text-muted">Sentences Claude commented on that couldn't be marked in the text.</p>
          <ul className="mt-3 space-y-4">
            {unplaced.map((thread) => (
              <li key={thread.id} className="space-y-2">
                <VerdictBadge verdict={thread.verdict} resolved={thread.resolved} />
                {thread.sentence !== null && (
                  <blockquote className="border-l-2 border-line pl-3 text-sm" lang={languageTag(entry.language)}>
                    {thread.sentence}
                  </blockquote>
                )}
                <ThreadConversation thread={thread} actions={actions} notesLanguage={entry.notesLanguage} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
