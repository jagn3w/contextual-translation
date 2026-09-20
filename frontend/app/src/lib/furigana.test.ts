import { parseFurigana } from "./furigana.ts";

/** What the pane ends up showing — and what a user copies out of it. */
const plainText = (annotated: string) =>
  parseFurigana(annotated)
    .map((segment) => segment.text)
    .join("");

describe("parseFurigana", () => {
  it("returns one plain run when there is nothing annotated", () => {
    expect(parseFurigana("こんにちは")).toEqual([{ text: "こんにちは" }]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseFurigana("")).toEqual([]);
  });

  it("puts a reading over the maximal run of kanji before it", () => {
    expect(parseFurigana("天気《てんき》です")).toEqual([{ text: "天気", reading: "てんき" }, { text: "です" }]);
  });

  it("reads a realistic sentence with several annotations", () => {
    expect(parseFurigana("今日《きょう》は良《よ》い天気《てんき》ですね")).toEqual([
      { text: "今日", reading: "きょう" },
      { text: "は" },
      { text: "良", reading: "よ" },
      { text: "い" },
      { text: "天気", reading: "てんき" },
      { text: "ですね" },
    ]);
  });

  it("keeps the iteration and abbreviation marks inside the base", () => {
    expect(parseFurigana("人々《ひとびと》")).toEqual([{ text: "人々", reading: "ひとびと" }]);
    expect(parseFurigana("三ヶ月《さんかげつ》")).toEqual([{ text: "三ヶ月", reading: "さんかげつ" }]);
    expect(parseFurigana("〆切《しめきり》")).toEqual([{ text: "〆切", reading: "しめきり" }]);
  });

  it("annotates a CJK Extension A character", () => {
    expect(parseFurigana("㐁《てん》")).toEqual([{ text: "㐁", reading: "てん" }]);
  });

  it("falls back to the single character before a group that doesn't follow kanji", () => {
    // The fake translator used in development and backend tests (design D2.4) annotates its tag.
    expect(parseFurigana("[JA]《ジェイエー》 Hello")).toEqual([
      { text: "[JA" },
      { text: "]", reading: "ジェイエー" },
      { text: " Hello" },
    ]);
  });

  it("drops a reading with nothing usable in front of it", () => {
    expect(parseFurigana("《よみ》です")).toEqual([{ text: "です" }]);
    expect(parseFurigana("今日 《きょう》")).toEqual([{ text: "今日 " }]);
    expect(parseFurigana("行《い》《く》")).toEqual([{ text: "行", reading: "い" }]);
  });

  it("drops an empty reading rather than emitting a ruby over nothing", () => {
    expect(parseFurigana("漢字《》を書く")).toEqual([{ text: "漢字を書く" }]);
  });

  it("merges the plain runs on either side of a dropped group", () => {
    expect(parseFurigana("ab《》cd")).toEqual([{ text: "abcd" }]);
  });

  it("preserves newlines and every other character exactly", () => {
    expect(parseFurigana("一行目《いちぎょうめ》\n\n二行目《にぎょうめ》！")).toEqual([
      { text: "一行目", reading: "いちぎょうめ" },
      { text: "\n\n" },
      { text: "二行目", reading: "にぎょうめ" },
      { text: "！" },
    ]);
  });

  it("leaves a lone bracket alone: only a whole group is markup", () => {
    expect(parseFurigana("《 is a bracket")).toEqual([{ text: "《 is a bracket" }]);
  });

  it("strips back to the plain translation, which is what the user copies", () => {
    expect(plainText("漢字《かんじ》を書《か》く")).toBe("漢字を書く");
    expect(plainText("[JA]《ジェイエー》 Hello")).toBe("[JA] Hello");
  });
});
