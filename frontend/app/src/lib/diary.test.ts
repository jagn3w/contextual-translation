import { entry, localIso, sentenceThread, thread } from "../test/diaryFixtures.ts";
import {
  feedbackRuns,
  formatDayHeading,
  formatTime,
  groupEntriesByDay,
  unplacedSentenceThreads,
  verdictLabel,
} from "./diary.ts";

describe("feedbackRuns", () => {
  const body = "今日は山に行った。楽しかったです。";

  it("cuts the reviewed body into plain and highlighted runs that join back to the body", () => {
    const threads = [
      sentenceThread("a", body, "今日は山に行った。", "IMPROVABLE"),
      sentenceThread("b", body, "楽しかったです。", "CORRECT"),
    ];

    const runs = feedbackRuns(body, threads);

    expect(runs.map((run) => [run.text, run.thread?.id])).toEqual([
      ["今日は山に行った。", "a"],
      ["楽しかったです。", "b"],
    ]);
    expect(runs.map((run) => run.text).join("")).toBe(body);
  });

  it("counts offsets in code points, so a character outside the BMP doesn't shift what follows", () => {
    // 😊 is one code point and two UTF-16 units: indexing by units would start the span one early.
    const text = "😊 Fui al parque. Comí helado.";
    const runs = feedbackRuns(text, [sentenceThread("a", text, "Comí helado.", "WRONG")]);

    expect(runs.map((run) => run.text)).toEqual(["😊 Fui al parque. ", "Comí helado."]);
  });

  it("drops overlapping, out-of-range, empty and fractional spans rather than trusting them", () => {
    const text = "One. Two. Three.";
    const runs = feedbackRuns(text, [
      thread({ id: "ok", verdict: "WRONG", startsAt: 0, length: 4 }),
      thread({ id: "overlap", verdict: "WRONG", startsAt: 2, length: 5 }),
      thread({ id: "past-end", verdict: "WRONG", startsAt: 10, length: 50 }),
      thread({ id: "empty", verdict: "WRONG", startsAt: 5, length: 0 }),
      thread({ id: "fraction", verdict: "WRONG", startsAt: 5.5, length: 2 }),
      thread({ id: "negative", verdict: "WRONG", startsAt: -1, length: 2 }),
    ]);

    expect(runs.filter((run) => run.thread !== undefined).map((run) => run.thread?.id)).toEqual(["ok"]);
    expect(runs.map((run) => run.text).join("")).toBe(text);
  });

  it("orders spans by position whatever order the threads come in", () => {
    const text = "One. Two.";
    const runs = feedbackRuns(text, [
      sentenceThread("second", text, "Two.", "CORRECT"),
      sentenceThread("first", text, "One.", "WRONG"),
    ]);

    expect(runs.map((run) => run.thread?.id ?? null)).toEqual(["first", null, "second"]);
  });

  it("highlights only current, located sentence threads — resolved ones included, so they can be reopened", () => {
    const text = "One. Two. Three.";
    const runs = feedbackRuns(text, [
      sentenceThread("resolved", text, "One.", "WRONG", { resolved: true }),
      sentenceThread("old", text, "Two.", "WRONG", { current: false }),
      thread({ id: "unlocated", verdict: "WRONG", sentence: "Three." }),
      thread({ id: "note", kind: "ENTRY", title: "Particles", startsAt: 10, length: 6 }),
    ]);

    expect(runs.filter((run) => run.thread !== undefined).map((run) => run.thread?.id)).toEqual(["resolved"]);
  });

  it("returns nothing for an empty body", () => {
    expect(feedbackRuns("", [])).toEqual([]);
  });
});

describe("unplacedSentenceThreads", () => {
  it("lists the current sentence threads that have no usable span", () => {
    const text = "One. Two.";
    const threads = [
      sentenceThread("placed", text, "One.", "CORRECT"),
      thread({ id: "unlocated", verdict: "WRONG", sentence: "Twoo." }),
      thread({ id: "bad-span", verdict: "WRONG", startsAt: 40, length: 3 }),
      thread({ id: "old", verdict: "WRONG", current: false }),
    ];

    expect(unplacedSentenceThreads(text, threads).map((t) => t.id)).toEqual(["unlocated", "bad-span"]);
  });
});

describe("verdictLabel", () => {
  it("names each verdict in words", () => {
    expect(verdictLabel("WRONG")).toBe("Needs fixing");
    expect(verdictLabel("IMPROVABLE")).toBe("Could be better");
    expect(verdictLabel("CORRECT")).toBe("Natural");
  });
});

describe("groupEntriesByDay", () => {
  const now = new Date(2026, 8, 21, 20, 0);

  it("puts entries from the same local day under one heading, keeping the order given", () => {
    const entries = [
      entry({ id: "evening", createdAt: localIso(2026, 9, 21, 21, 30) }),
      entry({ id: "morning", createdAt: localIso(2026, 9, 21, 7, 5) }),
      entry({ id: "yesterday", createdAt: localIso(2026, 9, 20, 23, 59) }),
      entry({ id: "older", createdAt: localIso(2026, 9, 14, 12, 0) }),
    ];

    const groups = groupEntriesByDay(entries, now, "en-US");

    expect(groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ["Today", ["evening", "morning"]],
      ["Yesterday", ["yesterday"]],
      ["Mon, Sep 14", ["older"]],
    ]);
  });

  it("returns no groups for no entries", () => {
    expect(groupEntriesByDay([], now)).toEqual([]);
  });
});

describe("date formatting", () => {
  const now = new Date(2026, 8, 21, 12, 0);

  it("adds the year only to a heading from another year", () => {
    expect(formatDayHeading(localIso(2026, 3, 2), now, "en-US")).toBe("Mon, Mar 2");
    expect(formatDayHeading(localIso(2025, 12, 31), now, "en-US")).toBe("Wed, Dec 31, 2025");
  });

  it("knows yesterday across a month boundary", () => {
    expect(formatDayHeading(localIso(2026, 8, 31, 22), new Date(2026, 8, 1, 8), "en-US")).toBe("Yesterday");
  });

  it("gives the time of day", () => {
    expect(formatTime(localIso(2026, 9, 21, 7, 5), "en-US")).toBe("7:05 AM");
    expect(formatTime(localIso(2026, 9, 21, 21, 30), "en-GB")).toBe("21:30");
  });
});
