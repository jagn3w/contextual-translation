/**
 * A small in-memory diary behind the fake server: enough of the backend's behaviour (docs/diary.md)
 * that the page's queries, mutations and cache updates are exercised end to end. Every object
 * carries its `__typename`, as the real server's do, because Apollo's cache normalises on it, and a
 * random UUID for its id, as the real server's public ids are. The preview, the hint levels and
 * the refusals (NOT_FOUND, INVALID, SAME_LANGUAGE) follow the backend's rules; the words Claude
 * would write are canned.
 */
import type { DiaryEntry, DiaryThread, DiaryVerdict } from "../lib/diary.ts";
import { type FakeServer, json } from "./fakeServer.ts";

type Language = DiaryEntry["language"];

export type FakeDiary = {
  entries: DiaryEntry[];
  find: (id: string) => DiaryEntry | undefined;
};

const VERDICTS: DiaryVerdict[] = ["WRONG", "CORRECT", "IMPROVABLE"];

/** Ids are random UUIDs, as the real server's public ids are (docs/api_boundary.md). */
function nextId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * DiaryEntry#preview: the first 12 words (at most 100 characters) for a language written with
 * spaces, the first 40 characters for Japanese, and "…" when that cut anything. Characters are code
 * points, as Ruby counts them; words are split on ASCII whitespace, as Ruby's String#split does.
 */
function previewOf(body: string, language: Language): string {
  const words = body.split(/[ \t\n\v\f\r]+/).filter((word) => word !== "");
  const text = Array.from(words.join(" "));
  const cut =
    language === "JA" ? text.slice(0, 40) : Array.from(words.slice(0, 12).join(" ")).slice(0, 100);
  return cut.length < text.length ? `${cut.join("")}…` : cut.join("");
}

/**
 * Diary::FakeTutor#hint: the first answer to a question with "want" in it asks which meaning the
 * learner has in mind (clarifying), as "I want a hamburger" could mean two things; otherwise, and
 * once the thread has anything in it, it is the hint at `level`.
 */
function hintFor(question: string, hasComments: boolean, level: number): { text: string; clarifying: boolean } {
  if (!hasComments && /\bwant\b/i.test(question)) {
    return { text: `Which do you mean? (for: ${question})`, clarifying: true };
  }
  return { text: level === 1 ? "Hint 1: think about the past tense." : `Hint ${level}: key vocabulary.`, clarifying: false };
}

export const notFound = () =>
  json({ data: null, errors: [{ message: "Not found", extensions: { code: "NOT_FOUND" } }] });

export const invalid = () =>
  json({
    data: null,
    errors: [
      {
        message: "An entry's languages can't be changed once it has had feedback or help.",
        extensions: { code: "INVALID" },
      },
    ],
  });

function summary(entry: DiaryEntry) {
  return {
    __typename: "DiaryEntry",
    id: entry.id,
    language: entry.language,
    notesLanguage: entry.notesLanguage,
    preview: entry.preview,
    createdAt: entry.createdAt,
  };
}

function threadJson(thread: DiaryThread) {
  return {
    __typename: "DiaryThread",
    ...thread,
    comments: thread.comments.map((comment) => ({ __typename: "DiaryComment", ...comment })),
  };
}

function full(entry: DiaryEntry) {
  return {
    ...summary(entry),
    body: entry.body,
    reviewedBody: entry.reviewedBody,
    reviewedAt: entry.reviewedAt,
    updatedAt: entry.updatedAt,
    threads: entry.threads.map(threadJson),
  };
}

function tutorComment(body: string) {
  return { id: nextId(), author: "TUTOR" as const, body, createdAt: now() };
}

function learnerComment(body: string) {
  return { id: nextId(), author: "LEARNER" as const, body, createdAt: now() };
}

/** Sentences ending in 。 . ! or ?, each with the code-point offset it starts at. */
function sentences(body: string): Array<{ text: string; startsAt: number }> {
  const found: Array<{ text: string; startsAt: number }> = [];
  const pattern = /[^。.!?]+[。.!?]?/gu;
  for (const match of body.matchAll(pattern)) {
    const raw = match[0];
    const text = raw.trim();
    if (text === "") continue;
    const at = (match.index ?? 0) + raw.indexOf(text);
    found.push({ text, startsAt: Array.from(body.slice(0, at)).length });
  }
  return found;
}

type Input = Record<string, unknown>;
function inputOf(body: Record<string, unknown>): Input {
  return (body["variables"] as { input: Input }).input;
}

export function installFakeDiary(server: FakeServer, initial: DiaryEntry[] = []): FakeDiary {
  // Copied, so one test's edits never leak into the fixtures the next test starts from.
  const entries = structuredClone(initial);
  const find = (id: string) => entries.find((entry) => entry.id === id);
  const findThread = (id: string) =>
    entries.flatMap((entry) => entry.threads).find((thread) => thread.id === id);
  const entryPayload = (entry: DiaryEntry | null, errors: unknown[] = []) => ({
    __typename: "DiaryEntryPayload",
    entry: entry === null ? null : full(entry),
    errors,
  });
  const threadPayload = (thread: DiaryThread) => ({ __typename: "DiaryThreadPayload", thread: threadJson(thread), errors: [] });

  server.onGraphql("DiaryEntries", () => json({ data: { diaryEntries: entries.map(summary) } }));
  server.onGraphql("DiaryEntry", (body) => {
    const id = (body["variables"] as { id: string }).id;
    const entry = find(id);
    return json({ data: { diaryEntry: entry === undefined ? null : full(entry) } });
  });

  server.onGraphql("CreateDiaryEntry", (body) => {
    const input = inputOf(body);
    const entry: DiaryEntry = {
      id: nextId(),
      language: input["language"] as Language,
      notesLanguage: input["notesLanguage"] as Language,
      body: "",
      preview: "",
      reviewedBody: null,
      reviewedAt: null,
      createdAt: now(),
      updatedAt: now(),
      threads: [],
    };
    entries.unshift(entry);
    return json({ data: { createDiaryEntry: entryPayload(entry) } });
  });

  server.onGraphql("SaveDiaryEntry", (body) => {
    const input = inputOf(body);
    const entry = find(input["id"] as string);
    if (entry === undefined) return notFound();
    const language = (input["language"] as Language | undefined) ?? entry.language;
    const notesLanguage = (input["notesLanguage"] as Language | undefined) ?? entry.notesLanguage;
    // Diary::Service#update_entry: the pair is fixed once feedback or help was written for it.
    const changesLanguages = language !== entry.language || notesLanguage !== entry.notesLanguage;
    if (changesLanguages && (entry.reviewedAt !== null || entry.threads.length > 0)) return invalid();
    if (language === notesLanguage) {
      const error = { __typename: "TranslateError", code: "SAME_LANGUAGE", message: "Same", retryable: false, retryAfterSeconds: null };
      return json({ data: { updateDiaryEntry: entryPayload(null, [error]) } });
    }
    const text = typeof input["body"] === "string" ? input["body"] : entry.body;
    // The server derives the preview on read, so a language change alone can change it too.
    Object.assign(entry, { language, notesLanguage, body: text, preview: previewOf(text, language), updatedAt: now() });
    const saved = full(entry);
    return json({
      data: {
        updateDiaryEntry: {
          __typename: "DiaryEntryPayload",
          entry: { ...summary(entry), body: saved.body, updatedAt: saved.updatedAt },
          errors: [],
        },
      },
    });
  });

  server.onGraphql("DeleteDiaryEntry", (body) => {
    const id = inputOf(body)["id"] as string;
    const at = entries.findIndex((entry) => entry.id === id);
    if (at < 0) return notFound();
    entries.splice(at, 1);
    return json({ data: { deleteDiaryEntry: { __typename: "DeleteDiaryEntryPayload", deletedId: id } } });
  });

  // One verdict per sentence, cycling WRONG → CORRECT → IMPROVABLE, and one entry-wide note.
  server.onGraphql("ReviewDiaryEntry", (body) => {
    const input = inputOf(body);
    const entry = find(input["id"] as string);
    if (entry === undefined) return notFound();
    const text = input["body"] as string;
    const superseded = entry.threads.map((thread) => (thread.kind === "SENTENCE" ? { ...thread, current: false } : thread));
    const reviewed = sentences(text).map(({ text: sentence, startsAt }, index): DiaryThread => {
      const verdict = VERDICTS[index % VERDICTS.length] ?? "CORRECT";
      return {
        id: nextId(),
        kind: "SENTENCE",
        verdict,
        sentence,
        startsAt,
        length: Array.from(sentence).length,
        title: null,
        current: true,
        hintLevel: 0,
        resolved: false,
        createdAt: now(),
        comments: [tutorComment(`Tip for: ${sentence}`)],
      };
    });
    const note: DiaryThread = {
      id: nextId(),
      kind: "ENTRY",
      verdict: null,
      sentence: null,
      startsAt: null,
      length: null,
      title: "Watch your particles",
      current: true,
      hintLevel: 0,
      resolved: false,
      createdAt: now(),
      comments: [tutorComment("に marks a destination.")],
    };
    Object.assign(entry, {
      body: text,
      preview: previewOf(text, entry.language),
      reviewedBody: text,
      reviewedAt: now(),
      threads: [...superseded, ...reviewed, note],
    });
    return json({ data: { reviewDiaryEntry: entryPayload(entry) } });
  });

  server.onGraphql("StartDiaryHelpThread", (body) => {
    const input = inputOf(body);
    const entry = find(input["entryId"] as string);
    if (entry === undefined) return notFound();
    const question = input["question"] as string;
    const hint = hintFor(question, false, 1);
    const thread: DiaryThread = {
      id: nextId(),
      kind: "HELP",
      verdict: null,
      sentence: question,
      startsAt: null,
      length: null,
      title: null,
      current: true,
      // A clarifying question is not the first hint, so the next one still is.
      hintLevel: hint.clarifying ? 0 : 1,
      resolved: false,
      createdAt: now(),
      comments: [tutorComment(hint.text)],
    };
    entry.threads.push(thread);
    return json({ data: { startDiaryHelpThread: threadPayload(thread) } });
  });

  server.onGraphql("ReplyToDiaryThread", (body) => {
    const input = inputOf(body);
    const thread = findThread(input["threadId"] as string);
    if (thread === undefined) return notFound();
    thread.comments.push(learnerComment(input["body"] as string), tutorComment(`Answer to: ${String(input["body"])}`));
    return json({ data: { replyToDiaryThread: threadPayload(thread) } });
  });

  server.onGraphql("RequestDiaryHint", (body) => {
    const thread = findThread(inputOf(body)["threadId"] as string);
    if (thread === undefined) return notFound();
    const level = thread.hintLevel + 1;
    const hint = hintFor(thread.sentence ?? "", thread.comments.length > 0, level);
    thread.comments.push(tutorComment(hint.text));
    // A clarifying answer leaves the level where it was: the hint it replaced is still to come.
    if (!hint.clarifying) thread.hintLevel = level;
    return json({ data: { requestDiaryHint: threadPayload(thread) } });
  });

  server.onGraphql("ResolveDiaryThread", (body) => {
    const input = inputOf(body);
    const thread = findThread(input["threadId"] as string);
    if (thread === undefined) return notFound();
    thread.resolved = input["resolved"] as boolean;
    return json({ data: { resolveDiaryThread: threadPayload(thread) } });
  });

  server.onGraphql("SuggestDiaryTopics", () =>
    json({
      data: {
        suggestDiaryTopics: {
          __typename: "DiaryTopicsPayload",
          topics: [
            { __typename: "DiaryTopic", prompt: "週末に何をしましたか？", gloss: "What did you do at the weekend?" },
            { __typename: "DiaryTopic", prompt: "好きな季節は？", gloss: "Your favourite season?" },
            { __typename: "DiaryTopic", prompt: "今日の晩ご飯", gloss: "Tonight's dinner" },
          ],
          errors: [],
        },
      },
    }),
  );

  return { entries, find };
}
