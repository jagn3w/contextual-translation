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

  it("keeps a compatibility ideograph inside the base", () => {
    // 﨑 is U+FA11, in the compatibility block rather than the unified one, and ordinary in a
    // name: left out of the kanji class the run stops short and みやざき lands over 﨑 alone.
    expect(parseFurigana("宮﨑《みやざき》")).toEqual([{ text: "宮﨑", reading: "みやざき" }]);
  });

  it("keeps an astral extension character inside the base", () => {
    // 𠮟 is U+20B9F (Extension B): one character, two UTF-16 units. Left out of the class the
    // run starts at 責 and しっせき would be written over 責 by itself.
    expect(parseFurigana("𠮟責《しっせき》")).toEqual([{ text: "𠮟責", reading: "しっせき" }]);
  });

  it("keeps 〇 and the small ヵ inside the base, like 々 and ヶ", () => {
    expect(parseFurigana("〇〇《まるまる》")).toEqual([{ text: "〇〇", reading: "まるまる" }]);
    expect(parseFurigana("一ヵ月《いっかげつ》")).toEqual([{ text: "一ヵ月", reading: "いっかげつ" }]);
  });

  it("keeps the full-size ケ/カ/ノ/ツ that spell a kanji word inside the base", () => {
    // Place and counter names write these as full-size katakana — 霞ケ関 is how the Tokyo Metro
    // spells Kasumigaseki — and they sit *inside* the word. Left out of the run the reading lands
    // over the tail alone and the pane teaches that 関 reads かすみがせき, which is the exact lie the
    // module exists to prevent; the annotateTranslation round-trip can't catch it, because a
    // partial base is still non-empty and still strips back to the translation.
    expect(parseFurigana("霞ケ関《かすみがせき》")).toEqual([{ text: "霞ケ関", reading: "かすみがせき" }]);
    expect(parseFurigana("四ツ谷《よつや》")).toEqual([{ text: "四ツ谷", reading: "よつや" }]);
    expect(parseFurigana("一ノ瀬《いちのせ》")).toEqual([{ text: "一ノ瀬", reading: "いちのせ" }]);
    expect(parseFurigana("一ケ月《いっかげつ》")).toEqual([{ text: "一ケ月", reading: "いっかげつ" }]);
    expect(parseFurigana("一カ所《いっかしょ》")).toEqual([{ text: "一カ所", reading: "いっかしょ" }]);
  });

  it("will not start a base at one of those letters, so a katakana word keeps them", () => {
    // The price of admitting ケ/カ/ノ/ツ: each is an ordinary katakana letter too. They are taken
    // only with a true kanji on both sides, so the run here is 水 and バケツ stays plain text —
    // みず written over ケツ水 would be the same lie in the other direction.
    expect(parseFurigana("バケツ水《みず》")).toEqual([{ text: "バケツ" }, { text: "水", reading: "みず" }]);
    expect(parseFurigana("ノート《のーと》")).toEqual([{ text: "ノート" }]);
    expect(parseFurigana("カタカナ語《ご》")).toEqual([{ text: "カタカナ" }, { text: "語", reading: "ご" }]);
  });

  it("trims a run back rather than ending it on one of those letters", () => {
    // A run has to end in a true kanji, and the base has to be the text immediately before the
    // group, so there is nothing left for かすみが to sit over: dropped, like any other reading
    // that doesn't follow kanji.
    expect(parseFurigana("霞ケ《かすみが》")).toEqual([{ text: "霞ケ" }]);
  });

  it("drops a reading that doesn't follow kanji rather than writing it over the wrong base", () => {
    // The backend guarantees only that stripping the groups reproduces the translation, never
    // where a group sits. Over the character before it, おねがい would be written over い alone —
    // wrong, in the pane someone is reading the Japanese out of, where a gap is merely a gap.
    expect(parseFurigana("お願い《おねがい》します")).toEqual([{ text: "お願いします" }]);
    expect(parseFurigana("[JA]《ジェイエー》 Hello")).toEqual([{ text: "[JA] Hello" }]);
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
