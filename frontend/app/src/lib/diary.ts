/**
 * The diary's shapes and the pure logic over them (docs/diary.md). The shapes are the generated
 * fragment types of src/graphql/diary.graphql, renamed for the components, so a field the page
 * reads is a field the operations fetch.
 */
import type {
  DiaryAuthor,
  DiaryCommentFieldsFragment,
  DiaryEntryFieldsFragment,
  DiaryEntrySummaryFieldsFragment,
  DiaryThreadFieldsFragment,
  DiaryThreadKind,
  DiaryVerdict,
  SuggestDiaryTopicsMutation,
} from "../gql/graphql.ts";
import { assertNever } from "./assertNever.ts";

export type { DiaryAuthor, DiaryThreadKind, DiaryVerdict };
export type DiaryComment = DiaryCommentFieldsFragment;
export type DiaryThread = DiaryThreadFieldsFragment;
/** What the scrollback shows of an entry; the list query doesn't fetch bodies or threads. */
export type DiaryEntrySummary = DiaryEntrySummaryFieldsFragment;
export type DiaryEntry = DiaryEntryFieldsFragment;
export type DiaryTopic = SuggestDiaryTopicsMutation["suggestDiaryTopics"]["topics"][number];

/** The same limits the backend enforces, counted in code points (see codePoints.ts). */
export const MAX_BODY_LENGTH = 10_000;
export const MAX_COMMENT_LENGTH = 2_000;

/**
 * A verdict in words. The highlight colour is never the only thing saying which verdict a sentence
 * got (WCAG 1.4.1): this label is on the card, in the legend and in the highlight's accessible name.
 */
export function verdictLabel(verdict: DiaryVerdict): string {
  switch (verdict) {
    case "WRONG":
      return "Needs fixing";
    case "IMPROVABLE":
      return "Could be better";
    case "CORRECT":
      return "Natural";
    default:
      return assertNever(verdict);
  }
}

/** A stretch of `reviewedBody`: plain text, or one sentence the tutor gave a verdict on. */
export type FeedbackRun = { text: string; thread?: DiaryThread };

/** Whether a sentence thread can be drawn over the text: current, with a span, and a verdict. */
function isHighlightable(thread: DiaryThread): boolean {
  return (
    thread.kind === "SENTENCE" &&
    thread.current &&
    thread.verdict !== null &&
    thread.startsAt !== null &&
    thread.length !== null
  );
}

/**
 * `reviewedBody` cut into consecutive runs, one per located, current sentence thread plus the
 * plain text between them. Concatenating the runs' text gives the body back exactly.
 *
 * Offsets are Unicode code points, as the backend counts them (Ruby String#length) — not the UTF-16
 * units JS indexes strings by, which would slide every highlight after an emoji or a rare kanji.
 * The backend promises ordered, non-overlapping, in-range spans (the GlossLocator rule), but a span
 * that breaks the promise is dropped rather than trusted, exactly as annotateTranslation does with
 * glosses: all it costs is a highlight, and the thread is still listed where it can be read.
 * Resolved threads keep their run — the page draws them without colour, but they stay clickable so
 * they can be reopened.
 */
export function feedbackRuns(reviewedBody: string, threads: readonly DiaryThread[]): FeedbackRun[] {
  const characters = Array.from(reviewedBody);
  const located = threads
    .filter(isHighlightable)
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));
  const runs: FeedbackRun[] = [];
  let cursor = 0;
  for (const thread of located) {
    const from = thread.startsAt ?? 0;
    const length = thread.length ?? 0;
    const to = from + length;
    if (!Number.isInteger(from) || !Number.isInteger(length)) continue;
    if (length <= 0 || from < cursor || to > characters.length) continue;
    if (from > cursor) runs.push({ text: characters.slice(cursor, from).join("") });
    runs.push({ text: characters.slice(from, to).join(""), thread });
    cursor = to;
  }
  if (cursor < characters.length) runs.push({ text: characters.slice(cursor).join("") });
  return runs;
}

/**
 * The current sentence threads that feedbackRuns could not place — unlocated by the backend, or
 * with a span it had to drop. Their verdicts still stand, so the page lists them under the text
 * instead of losing them.
 */
export function unplacedSentenceThreads(reviewedBody: string, threads: readonly DiaryThread[]): DiaryThread[] {
  const placed = new Set(
    feedbackRuns(reviewedBody, threads).flatMap((run) => (run.thread === undefined ? [] : [run.thread.id])),
  );
  return threads.filter((thread) => thread.kind === "SENTENCE" && thread.current && !placed.has(thread.id));
}

/** The calendar day an instant falls on, in the viewer's time zone, as a sortable `YYYY-MM-DD`. */
export function localDayKey(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export type DayGroup<T> = { key: string; label: string; entries: T[] };

/**
 * Entries under one heading per local calendar day, in the order given (the API sends newest
 * first). Grouped by the viewer's day, not UTC's: an entry written at 11pm in Tokyo belongs to
 * that evening, not to the next morning.
 */
export function groupEntriesByDay<T extends { createdAt: string }>(
  entries: readonly T[],
  now: Date = new Date(),
  locale?: string,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const entry of entries) {
    const key = localDayKey(entry.createdAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: formatDayHeading(entry.createdAt, now, locale), entries: [entry] });
  }
  return groups;
}

/** "Today", "Yesterday", or the date — with the year only when it isn't this one. */
export function formatDayHeading(iso: string, now: Date = new Date(), locale?: string): string {
  const key = localDayKey(iso);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  const date = new Date(iso);
  return date.toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The time of day, which is what tells two entries under one date heading apart. */
export function formatTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** The full date and time, for the entry's own header. */
export function formatDateTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
