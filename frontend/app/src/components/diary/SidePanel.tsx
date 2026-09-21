import { type ReactNode, useId, useState } from "react";
import { type DiaryEntry, type DiaryThread, type DiaryTopic } from "../../lib/diary.ts";
import { languageName, languageTag } from "../../lib/languages.ts";
import { askingClaude, useElapsedSeconds } from "../../lib/useElapsedSeconds.ts";
import { usePending } from "../../lib/usePending.ts";
import { VerdictBadge } from "./SentenceHighlight.tsx";
import { ReplyBox, SECONDARY_BUTTON, type ThreadActions, ThreadConversation } from "./ThreadConversation.tsx";

type Props = {
  entry: DiaryEntry;
  actions: ThreadActions;
  /** Three writing prompts, or null when asking failed (the caller reports why). */
  onSuggestTopics: () => Promise<DiaryTopic[] | null>;
  /** Opens a HELP thread; resolves true once Claude's first hint is in it. */
  onStartHelp: (question: string) => Promise<boolean>;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h2 id={id} className="mb-2 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The column beside the entry: ideas when stuck, help saying something, Claude's notes on the entry
 * as a whole, and the sentence feedback earlier reviews superseded. Resolved threads are hidden
 * unless asked for — they are done with — but never gone: "Show resolved" brings them back to be
 * read or reopened.
 */
export function SidePanel({ entry, actions, onSuggestTopics, onStartHelp }: Props) {
  const toggleId = useId();
  const [showResolved, setShowResolved] = useState(false);
  const visible = (thread: DiaryThread) => showResolved || !thread.resolved;
  const help = entry.threads.filter((thread) => thread.kind === "HELP" && visible(thread));
  const notes = entry.threads.filter((thread) => thread.kind === "ENTRY" && visible(thread));
  const earlier = entry.threads.filter((thread) => thread.kind === "SENTENCE" && !thread.current && visible(thread));
  const anyResolved = entry.threads.some((thread) => thread.resolved);

  return (
    <div className="space-y-5">
      <Ideas entry={entry} onSuggestTopics={onSuggestTopics} />

      <Section title="Help me say…">
        <HelpAsk entry={entry} onStartHelp={onStartHelp} />
        {help.length > 0 && (
          <ul className="mt-4 space-y-4">
            {help.map((thread) => (
              <li key={thread.id} className="rounded-lg border border-line p-3">
                <p className="mb-2 text-sm font-medium" lang={languageTag(entry.notesLanguage)}>
                  {thread.sentence}
                  {thread.resolved && <span className="ml-1 text-xs font-normal text-muted">· Resolved</span>}
                </p>
                <ThreadConversation
                  thread={thread}
                  actions={actions}
                  notesLanguage={entry.notesLanguage}
                  replyLabel="Ask something specific"
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notes on this entry">
        {notes.length === 0 ? (
          <p className="text-sm text-muted">
            {entry.reviewedBody === null ? "Claude's notes on the whole entry appear here after feedback." : "No open notes."}
          </p>
        ) : (
          <ul className="space-y-4">
            {notes.map((thread) => (
              <li key={thread.id} className="rounded-lg border border-line p-3">
                <p className="mb-2 text-sm font-medium" lang={languageTag(entry.notesLanguage)}>
                  {thread.title}
                  {thread.resolved && <span className="ml-1 text-xs font-normal text-muted">· Resolved</span>}
                </p>
                <ThreadConversation thread={thread} actions={actions} notesLanguage={entry.notesLanguage} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {earlier.length > 0 && (
        <Section title="Earlier feedback">
          <details className="group">
            <summary className="focus-ring cursor-pointer rounded text-sm text-muted hover:text-ink">
              {earlier.length === 1 ? "1 comment from an earlier review" : `${earlier.length} comments from earlier reviews`}
            </summary>
            <ul className="mt-3 space-y-4">
              {earlier.map((thread) => (
                <li key={thread.id} className="space-y-2 rounded-lg border border-line p-3">
                  {thread.verdict !== null && <VerdictBadge verdict={thread.verdict} resolved={thread.resolved} />}
                  {thread.sentence !== null && (
                    <blockquote className="border-l-2 border-line pl-3 text-sm" lang={languageTag(entry.language)}>
                      {thread.sentence}
                    </blockquote>
                  )}
                  <ThreadConversation thread={thread} actions={actions} notesLanguage={entry.notesLanguage} />
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {anyResolved && (
        <label htmlFor={toggleId} className="flex items-center gap-2 border-t border-line pt-4 text-sm text-muted">
          <input
            id={toggleId}
            type="checkbox"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
            className="focus-ring size-4 accent-accent"
          />
          Show resolved
        </label>
      )}
    </div>
  );
}

/** "Stuck? Get ideas": three prompts in the entry's language, each glossed in the learner's own. */
function Ideas({ entry, onSuggestTopics }: Pick<Props, "entry" | "onSuggestTopics">) {
  const [topics, setTopics] = useState<DiaryTopic[] | null>(null);
  const [asking, run] = usePending();
  const elapsed = useElapsedSeconds(asking);

  async function ask() {
    const result = await run(onSuggestTopics);
    if (result !== undefined && result !== null) setTopics(result);
  }

  return (
    <Section title="Stuck?">
      <div className="flex items-center gap-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={asking} onClick={() => void ask()}>
          {topics === null ? "Get ideas" : "Other ideas"}
        </button>
        {asking && <span className="text-xs text-muted">{askingClaude(elapsed) ?? "Asking Claude…"}</span>}
      </div>
      {topics !== null && (
        <ul className="mt-3 space-y-2">
          {topics.map((topic) => (
            <li key={topic.prompt} className="text-sm">
              <span className="block text-ink" lang={languageTag(entry.language)}>
                {topic.prompt}
              </span>
              <span className="block text-xs text-muted" lang={languageTag(entry.notesLanguage)}>
                {topic.gloss}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Asking how to say something, in the learner's own language; the answer is a hint, not the sentence. */
function HelpAsk({ entry, onStartHelp }: Pick<Props, "entry" | "onStartHelp">) {
  const [asking, setAsking] = useState(false);
  const elapsed = useElapsedSeconds(asking);
  return (
    <div>
      <ReplyBox
        label={`What do you want to say? Ask in ${languageName(entry.notesLanguage)}.`}
        placeholder={entry.notesLanguage === "EN" ? "How do I say I went hiking with my sister?" : undefined}
        sendLabel="Ask"
        lang={languageTag(entry.notesLanguage)}
        disabled={asking}
        onSend={async (question) => {
          setAsking(true);
          try {
            return await onStartHelp(question);
          } finally {
            setAsking(false);
          }
        }}
      />
      {asking && (
        <p className="mt-1 text-xs text-muted" role="status">
          {askingClaude(elapsed) ?? "Asking Claude…"}
        </p>
      )}
    </div>
  );
}
