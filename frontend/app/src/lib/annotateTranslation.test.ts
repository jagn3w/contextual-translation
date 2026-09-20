import { annotateTranslation, type AnnotatedRun, type Gloss } from "./annotateTranslation.ts";

/** The sentence most of these use: 今日(きょう)は良(よ)い天気(てんき)ですね, ten code points. */
const SENTENCE = "今日は良い天気ですね";
const SENTENCE_FURIGANA = "今日《きょう》は良《よ》い天気《てんき》ですね";

/** A gloss over `text` starting at `startsAt`, its length counted the way the backend counts it. */
const gloss = (text: string, startsAt: number, meaning = `definition of ${text}`): Gloss => ({
  text,
  reading: null,
  meaning,
  startsAt,
  length: Array.from(text).length,
});

/** What the pane ends up showing — and what a user copies out of it. */
const plainText = (runs: readonly AnnotatedRun[]) =>
  runs
    .flatMap((run) => run.parts)
    .map((part) => part.text)
    .join("");

describe("annotateTranslation", () => {
  it("returns nothing for an empty translation", () => {
    expect(annotateTranslation("", null, [])).toEqual([]);
    expect(annotateTranslation("", "", [])).toEqual([]);
  });

  it("returns one plain run when there are no glosses and no furigana", () => {
    expect(annotateTranslation("こんにちは", null, [])).toEqual([{ parts: [{ text: "こんにちは" }] }]);
  });

  it("returns one run carrying every reading when there are no glosses", () => {
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [])).toEqual([
      {
        parts: [
          { text: "今日", reading: "きょう" },
          { text: "は" },
          { text: "良", reading: "よ" },
          { text: "い" },
          { text: "天気", reading: "てんき" },
          { text: "ですね" },
        ],
      },
    ]);
  });

  it("gives a glossed word its own run when it covers one ruby segment exactly", () => {
    const weather = gloss("天気", 5, "the weather");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [weather])).toEqual([
      {
        parts: [
          { text: "今日", reading: "きょう" },
          { text: "は" },
          { text: "良", reading: "よ" },
          { text: "い" },
        ],
      },
      { parts: [{ text: "天気", reading: "てんき" }], gloss: weather },
      { parts: [{ text: "ですね" }] },
    ]);
  });

  it("keeps every segment, kana included, inside a gloss that spans several", () => {
    const fine = gloss("良い天気", 3, "fine weather");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [fine])).toEqual([
      { parts: [{ text: "今日", reading: "きょう" }, { text: "は" }] },
      {
        parts: [{ text: "良", reading: "よ" }, { text: "い" }, { text: "天気", reading: "てんき" }],
        gloss: fine,
      },
      { parts: [{ text: "ですね" }] },
    ]);
  });

  it("splits a ruby segment a gloss starts inside, leaving the reading on the kanji before it", () => {
    // 天|気です: the reading てんき was measured against 天気, so it stays on the piece that kept
    // the kanji rather than being halved or invented for the piece that lost it.
    const middle = gloss("気です", 6, "nonsense, but it starts mid-ruby");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [middle])).toEqual([
      {
        parts: [
          { text: "今日", reading: "きょう" },
          { text: "は" },
          { text: "良", reading: "よ" },
          { text: "い" },
          { text: "天", reading: "てんき" },
        ],
      },
      { parts: [{ text: "気です" }], gloss: middle },
      { parts: [{ text: "ね" }] },
    ]);
  });

  it("splits a ruby segment a gloss ends inside", () => {
    const middle = gloss("い天", 4, "nonsense, but it ends mid-ruby");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [middle])).toEqual([
      { parts: [{ text: "今日", reading: "きょう" }, { text: "は" }, { text: "良", reading: "よ" }] },
      { parts: [{ text: "い" }, { text: "天", reading: "てんき" }], gloss: middle },
      { parts: [{ text: "気ですね" }] },
    ]);
  });

  it("puts back-to-back glosses in back-to-back runs, with no plain run between them", () => {
    const today = gloss("今日", 0, "today");
    const topic = gloss("は", 2, "the topic particle");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [today, topic])).toEqual([
      { parts: [{ text: "今日", reading: "きょう" }], gloss: today },
      { parts: [{ text: "は" }], gloss: topic },
      {
        parts: [
          { text: "良", reading: "よ" },
          { text: "い" },
          { text: "天気", reading: "てんき" },
          { text: "ですね" },
        ],
      },
    ]);
  });

  it("glosses the very first and very last words without emitting empty runs", () => {
    const today = gloss("今日", 0, "today");
    const isnt = gloss("ですね", 7, "isn't it");
    expect(annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [today, isnt])).toEqual([
      { parts: [{ text: "今日", reading: "きょう" }], gloss: today },
      { parts: [{ text: "は" }, { text: "良", reading: "よ" }, { text: "い" }, { text: "天気", reading: "てんき" }] },
      { parts: [{ text: "ですね" }], gloss: isnt },
    ]);
  });

  it("counts an emoji as one character, the way the backend counts it", () => {
    // 🎉 is one code point but two UTF-16 units, so indexing the string directly would cut the
    // gloss a character early — and split the surrogate pair while doing it.
    const today = gloss("今日", 1, "today");
    expect(annotateTranslation("🎉今日は", "🎉今日《きょう》は", [today])).toEqual([
      { parts: [{ text: "🎉" }] },
      { parts: [{ text: "今日", reading: "きょう" }], gloss: today },
      { parts: [{ text: "は" }] },
    ]);
  });

  it("counts an emoji the same way with no furigana at all", () => {
    const cake = gloss("ケーキ", 4, "cake");
    expect(annotateTranslation("やった🎉ケーキ", null, [cake])).toEqual([
      { parts: [{ text: "やった🎉" }] },
      { parts: [{ text: "ケーキ" }], gloss: cake },
    ]);
  });

  it("merges adjacent parts with no reading, so the DOM stays minimal", () => {
    // The gloss ends inside 天気: the piece that lost the reading and the plain ですね that follows
    // it are one text node, not two.
    const parts = annotateTranslation(SENTENCE, SENTENCE_FURIGANA, [gloss("い天", 4)])[2]?.parts;
    expect(parts).toEqual([{ text: "気ですね" }]);
  });

  it("ignores a gloss that falls outside the translation", () => {
    const outside: Gloss[] = [
      { text: "?", reading: null, meaning: "past the end", startsAt: 5, length: 2 },
      { text: "?", reading: null, meaning: "ends past the end", startsAt: 2, length: 5 },
      { text: "?", reading: null, meaning: "before the start", startsAt: -1, length: 2 },
    ];
    for (const broken of outside) {
      expect(annotateTranslation("今日は", null, [broken])).toEqual([{ parts: [{ text: "今日は" }] }]);
    }
  });

  it("ignores a gloss that overlaps the one before it, keeping the first", () => {
    const today = gloss("今日", 0, "today");
    const overlapping = gloss("日は", 1, "overlaps 今日");
    expect(annotateTranslation("今日は", null, [today, overlapping])).toEqual([
      { parts: [{ text: "今日" }], gloss: today },
      { parts: [{ text: "は" }] },
    ]);
  });

  it("ignores a gloss with no length, or a fractional span", () => {
    const empty: Gloss[] = [
      { text: "", reading: null, meaning: "empty", startsAt: 1, length: 0 },
      { text: "?", reading: null, meaning: "negative", startsAt: 1, length: -2 },
      { text: "?", reading: null, meaning: "fractional", startsAt: 1.5, length: 1 },
    ];
    for (const broken of empty) {
      expect(annotateTranslation("今日は", null, [broken])).toEqual([{ parts: [{ text: "今日は" }] }]);
    }
  });

  it("drops the readings rather than the text when the furigana doesn't match the translation", () => {
    // A mismatch would slide every reading and every gloss boundary along by the difference.
    const today = gloss("今日", 0, "today");
    expect(annotateTranslation("今日は", "まったく別《べつ》の文", [today])).toEqual([
      { parts: [{ text: "今日" }], gloss: today },
      { parts: [{ text: "は" }] },
    ]);
  });

  it("gives back the translation character for character, whatever the annotations are", () => {
    const cases: [string, string | null, Gloss[]][] = [
      [SENTENCE, SENTENCE_FURIGANA, []],
      [SENTENCE, null, [gloss("天気", 5)]],
      [SENTENCE, SENTENCE_FURIGANA, [gloss("今日", 0), gloss("は", 2), gloss("ですね", 7)]],
      [SENTENCE, SENTENCE_FURIGANA, [gloss("気です", 6)]],
      [SENTENCE, SENTENCE_FURIGANA, [gloss("い天", 4)]],
      ["🎉今日は", "🎉今日《きょう》は", [gloss("今日", 1)]],
      ["やった🎉ケーキ", null, [gloss("🎉ケーキ", 3)]],
      ["一行目\n\n二行目", "一行目《いちぎょうめ》\n\n二行目《にぎょうめ》", [gloss("二行目", 5)]],
      ["今日は", null, [{ text: "?", reading: null, meaning: "broken", startsAt: 2, length: 9 }]],
      ["[JA] Hello", "[JA]《ジェイエー》 Hello", [gloss("Hello", 5, "a greeting")]],
    ];
    for (const [text, furigana, glosses] of cases) {
      expect(plainText(annotateTranslation(text, furigana, glosses))).toBe(text);
    }
  });
});
