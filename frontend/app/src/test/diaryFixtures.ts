import type { DiaryComment, DiaryEntry, DiaryThread } from "../lib/diary.ts";

/** An instant on a local calendar day, so date grouping reads the same in every time zone. */
export function localIso(year: number, month: number, day: number, hour = 9, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

let sequence = 0;

export function comment(author: DiaryComment["author"], body: string): DiaryComment {
  sequence += 1;
  return { id: `c${sequence}`, author, body, createdAt: localIso(2026, 9, 21) };
}

export function thread(overrides: Partial<DiaryThread> & Pick<DiaryThread, "id">): DiaryThread {
  return {
    kind: "SENTENCE",
    verdict: null,
    sentence: null,
    startsAt: null,
    length: null,
    title: null,
    current: true,
    hintLevel: 0,
    resolved: false,
    createdAt: localIso(2026, 9, 21),
    comments: [],
    ...overrides,
  };
}

/** A sentence thread located at `sentence`'s first occurrence in `body`, counted in code points. */
export function sentenceThread(
  id: string,
  body: string,
  sentence: string,
  verdict: NonNullable<DiaryThread["verdict"]>,
  overrides: Partial<DiaryThread> = {},
): DiaryThread {
  const at = body.indexOf(sentence);
  if (at < 0) throw new Error(`"${sentence}" is not in the body`);
  return thread({
    id,
    kind: "SENTENCE",
    verdict,
    sentence,
    startsAt: Array.from(body.slice(0, at)).length,
    length: Array.from(sentence).length,
    ...overrides,
  });
}

export function entry(overrides: Partial<DiaryEntry> & Pick<DiaryEntry, "id">): DiaryEntry {
  return {
    language: "JA",
    notesLanguage: "EN",
    body: "",
    preview: "",
    reviewedBody: null,
    reviewedAt: null,
    createdAt: localIso(2026, 9, 21),
    updatedAt: localIso(2026, 9, 21),
    threads: [],
    ...overrides,
  };
}
