import { useMemo } from "react";
import { type DiaryEntrySummary, formatTime, groupEntriesByDay } from "../../lib/diary.ts";
import { languageName, languageTag } from "../../lib/languages.ts";
import { handleLinkClick, routePath } from "../../lib/router.ts";
import { usePending } from "../../lib/usePending.ts";
import { PRIMARY_BUTTON } from "./ThreadConversation.tsx";

type Props = {
  /** Newest created first, as the API sends them; null while the list is loading. */
  entries: readonly DiaryEntrySummary[] | null;
  selectedId: string | null;
  onNewEntry: () => Promise<unknown>;
  /** For tests: the "today" the date headings are relative to. */
  now?: Date;
};

/**
 * The scrollback: New entry, then every entry under a heading for its day. Each entry is a link to
 * its own URL, so it can be opened in a new tab and the back button walks through what was read;
 * the one open is marked `aria-current="page"`.
 */
export function EntryList({ entries, selectedId, onNewEntry, now }: Props) {
  const [creating, runCreate] = usePending();
  const groups = useMemo(() => (entries === null ? [] : groupEntriesByDay(entries, now)), [entries, now]);

  return (
    <div>
      <button
        type="button"
        className={`${PRIMARY_BUTTON} w-full`}
        disabled={creating}
        onClick={() => void runCreate(onNewEntry)}
      >
        {creating ? "Creating…" : "New entry"}
      </button>
      <nav aria-label="Diary entries" className="mt-4">
        {entries === null ? (
          <p className="text-sm text-muted">Loading entries…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted">No entries yet. Start one — a few sentences about your day is plenty.</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mb-4" aria-labelledby={`day-${group.key}`}>
              <h3 id={`day-${group.key}`} className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {group.label}
              </h3>
              <ul className="space-y-0.5">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <a
                      href={routePath({ page: "diary", entryId: entry.id })}
                      onClick={handleLinkClick}
                      aria-current={entry.id === selectedId ? "page" : undefined}
                      className="focus-ring block rounded-md border-l-2 border-transparent px-2 py-1.5 hover:bg-surface aria-[current=page]:border-accent aria-[current=page]:bg-surface"
                    >
                      <span className="flex items-baseline justify-between gap-2 text-xs text-muted">
                        <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                        <span>{languageName(entry.language)}</span>
                      </span>
                      <span
                        className={`mt-0.5 block truncate text-sm ${entry.preview === "" ? "italic text-muted" : "text-ink"}`}
                        lang={entry.preview === "" ? undefined : languageTag(entry.language)}
                      >
                        {entry.preview === "" ? "Empty entry" : entry.preview}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
}
