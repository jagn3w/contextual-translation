/**
 * A small in-memory diary behind the fake server: enough of the backend's behaviour (docs/diary.md)
 * that the page's queries, mutations and cache updates are exercised end to end. Every object
 * carries its `__typename`, as the real server's do, because Apollo's cache normalises on it.
 */
import type { DiaryEntry, DiaryThread, DiaryVerdict } from "../lib/diary.ts";
import { type FakeServer, json } from "./fakeServer.ts";

type Language = DiaryEntry["language"];

export type FakeDiary = {
  entries: DiaryEntry[];
  find: (id: string) => DiaryEntry | undefined;
};

const VERDICTS: DiaryVerdict[] = ["WRONG", "CORRECT", "IMPROVABLE"];

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

function now(): string {
  return new Date().toISOString();
}

/** First ~12 words, as the backend's preview. */
function previewOf(body: string): string {
  return body.trim().split(/\s+/).slice(0, 12).join(" ");
}

export const notFound = () =>
  json({ data: null, errors: [{ message: "Not found", extensions: { code: "NOT_FOUND" } }] });

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
  return { id: nextId("c"), author: "TUTOR" as const, body, createdAt: now() };
}

function learnerComment(body: string) {
  return { id: nextId("c"), author: "LEARNER" as const, body, createdAt: now() };
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
      id: nextId("n"),
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
    if (language === notesLanguage) {
      const error = { __typename: "TranslateError", code: "SAME_LANGUAGE", message: "Same", retryable: false, retryAfterSeconds: null };
      return json({ data: { updateDiaryEntry: entryPayload(null, [error]) } });
    }
    Object.assign(entry, { language, notesLanguage, updatedAt: now() });
    if (typeof input["body"] === "string") Object.assign(entry, { body: input["body"], preview: previewOf(input["body"]) });
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
        id: nextId("t"),
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
      id: nextId("t"),
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
      preview: previewOf(text),
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
    const thread: DiaryThread = {
      id: nextId("h"),
      kind: "HELP",
      verdict: null,
      sentence: input["question"] as string,
      startsAt: null,
      length: null,
      title: null,
      current: true,
      hintLevel: 1,
      resolved: false,
      createdAt: now(),
      comments: [tutorComment("Hint 1: think about the past tense.")],
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
    thread.hintLevel += 1;
    thread.comments.push(tutorComment(`Hint ${thread.hintLevel}: key vocabulary.`));
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
