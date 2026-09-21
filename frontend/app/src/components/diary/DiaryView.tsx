import { useState } from "react";
import type { Language } from "../../gql/graphql.ts";
import type { DiaryEntry, DiaryEntrySummary, DiaryTopic } from "../../lib/diary.ts";
import { draftSaved, rememberDraft, unsavedDraft } from "../../lib/unsavedDrafts.ts";
import { useAutosave } from "../../lib/useAutosave.ts";
import { AnnounceContext } from "./announce.ts";
import { EntryEditor } from "./EntryEditor.tsx";
import { EntryList } from "./EntryList.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { SECONDARY_BUTTON, type ThreadActions } from "./ThreadConversation.tsx";

/**
 * Everything the diary can ask of the server. Each returns the mutation's promise so the control
 * that asked can show its own pending state; failures are reported by the caller (a toast worded
 * by translateErrorMessage or failureMessage) and signalled here by `false` / `null`, which leaves
 * the learner's input in place to try again.
 */
export type DiaryActions = ThreadActions & {
  /** Creates an entry and navigates to it. */
  onNewEntry: () => Promise<unknown>;
  /** Saves the draft; no tutor call. Resolves true once saved. */
  onSaveBody: (entryId: string, body: string) => Promise<boolean>;
  /** Saves `body` and has Claude review it. Resolves true once the review is in. */
  onRequestFeedback: (entryId: string, body: string) => Promise<boolean>;
  /** Changes an empty entry's languages. Leave out to show them read-only. */
  onChangeLanguages?: ((entryId: string, language: Language, notesLanguage: Language) => Promise<unknown>) | undefined;
  /** Deletes an entry; resolves true once it's gone (the caller then leaves its URL). */
  onDeleteEntry: (entryId: string) => Promise<boolean>;
  /** `body` is the draft on screen, saved or not: with text in it the ideas follow on from it. */
  onSuggestTopics: (entryId: string, body: string) => Promise<DiaryTopic[] | null>;
  onStartHelp: (entryId: string, question: string) => Promise<boolean>;
};

type Props = {
  /** The scrollback, newest created first; null while loading. */
  entries: readonly DiaryEntrySummary[] | null;
  /** The entry the URL names, if any. */
  selectedId: string | null;
  /** That entry in full; null while loading, or when it doesn't exist. */
  entry: DiaryEntry | null;
  entryLoading: boolean;
  /** Why the list or the entry couldn't be loaded, with a way to try again. */
  loadError?: string | null;
  onRetry?: () => void;
  actions: DiaryActions;
  /** For tests: the "today" the list's date headings are relative to. */
  now?: Date;
};

/**
 * The diary page's layout: the scrollback on the left, the entry in the middle, and the helpers on
 * the right. Below `lg` the helpers drop under the entry, and below `md` the scrollback goes on top
 * — capped in height, so a long diary doesn't push today's entry off the first screen.
 */
export function DiaryView({ entries, selectedId, entry, entryLoading, loadError = null, onRetry, actions, now }: Props) {
  const [announcement, setAnnouncement] = useState("");
  return (
    <AnnounceContext value={setAnnouncement}>
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 pb-16 md:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(0,1fr)_17rem]">
        <aside aria-label="Entries" className="max-h-72 overflow-y-auto md:row-span-2 md:max-h-none md:overflow-visible">
          <EntryList entries={entries} selectedId={selectedId} onNewEntry={actions.onNewEntry} {...(now ? { now } : {})} />
        </aside>
        {loadError !== null ? (
          <div className="py-12 text-center text-sm text-muted lg:col-span-2">
            <p role="alert">{loadError}</p>
            {onRetry !== undefined && (
              <button type="button" onClick={onRetry} className={`${SECONDARY_BUTTON} mt-4`}>
                Try again
              </button>
            )}
          </div>
        ) : entry !== null ? (
          // Keyed on the entry, so the draft, the autosave and the mode start fresh for each one —
          // and leaving an entry unmounts its workspace, which saves anything still pending.
          <EntryWorkspace key={entry.id} entry={entry} actions={actions} />
        ) : (
          <div className="py-12 text-center text-sm text-muted lg:col-span-2">
            {entryLoading || (selectedId === null && entries === null)
              ? "Loading…"
              : selectedId !== null
                ? "This entry doesn't exist, or belongs to another access code."
                : entries !== null && entries.length === 0
                  ? "Write a few sentences a day in the language you're learning, and Claude will mark them like a teacher. Start with New entry."
                  : "Choose an entry, or start a new one."}
          </div>
        )}
        {/* Always mounted, so screen readers announce each change: asking, the answer, a failure. */}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </main>
    </AnnounceContext>
  );
}

/** One entry's editor and side panel, owning its draft and the autosave that keeps it. */
function EntryWorkspace({ entry, actions }: { entry: DiaryEntry; actions: DiaryActions }) {
  // A draft the server may not have yet — left here moments ago, its save still out — wins over
  // the cached body, and counts as unsaved until it lands.
  const [body, setBody] = useState(() => unsavedDraft(entry.id) ?? entry.body);
  const autosave = useAutosave(
    body,
    async (text) => {
      const ok = await actions.onSaveBody(entry.id, text);
      if (ok) draftSaved(entry.id, text);
      return ok;
    },
    undefined,
    entry.body,
  );
  const { onChangeLanguages } = actions;

  return (
    <>
      <section aria-label="Entry" className="min-w-0">
        <EntryEditor
          entry={entry}
          body={body}
          onBodyChange={(text) => {
            rememberDraft(entry.id, text);
            setBody(text);
          }}
          saveState={autosave.state}
          onRequestFeedback={async (text) => {
            const ok = await actions.onRequestFeedback(entry.id, text);
            // The review saved this text on its way, so the autosave has nothing left to send —
            // unless the learner kept typing meanwhile, which markSaved then sends again.
            if (ok) {
              draftSaved(entry.id, text);
              autosave.markSaved(text);
            }
            return ok;
          }}
          onChangeLanguages={
            onChangeLanguages === undefined
              ? undefined
              : (language, notesLanguage) => onChangeLanguages(entry.id, language, notesLanguage)
          }
          onDelete={() => actions.onDeleteEntry(entry.id)}
          actions={actions}
        />
      </section>
      <aside aria-label="Help and notes" className="min-w-0 md:col-start-2 lg:col-start-auto">
        <SidePanel
          entry={entry}
          actions={actions}
          onSuggestTopics={() => actions.onSuggestTopics(entry.id, body)}
          onStartHelp={(question) => actions.onStartHelp(entry.id, question)}
        />
      </aside>
    </>
  );
}
