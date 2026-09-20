/**
 * Splits the backend's annotated Japanese (design D2.3) into runs to render, where an annotated
 * run becomes a `<ruby>`. The annotated string is the translation repeated verbatim with each
 * run of kanji followed by its reading in U+300A/U+300B double angle brackets — 漢字《かんじ》を
 * 書《か》く — and the backend guarantees it strips back to `text` character for character once
 * every 《…》 group is removed, so this only has to decide *what each reading is attached to*,
 * never to validate the string.
 */
export type RubySegment = { text: string; reading?: string };

/**
 * What a reading may be written over: the characters a kanji run is built from. It takes two
 * classes rather than one flat set, because the two failure modes pull in opposite directions.
 * A character left out entirely ends the run early, so the reading after it lands over the wrong
 * base (一ヵ月《いっかげつ》 would put いっかげつ over 月 alone). A character let in everywhere starts a
 * run of its own inside a katakana word, so バケツ水《みず》 would put みず over ケツ水.
 *
 * `KANJI` is what a run may *begin and end* with — the blocks a word's kanji are actually written
 * in, none of which can be mistaken for katakana:
 *   - CJK Unified Ideographs (一-鿿) and Extension A (㐀-䶿);
 *   - the compatibility ideographs (U+F900–U+FAFF), where the 﨑 of a name like 宮﨑 lives;
 *   - the astral extensions, B through the compatibility supplement (U+20000–U+2FA1F) — 𠮟, 𩸽 and
 *     most rare surname characters. The `u` flag is what makes this range match by code point;
 *   - the marks that appear only in a kanji word and never in a katakana one: 〇 (the zero of
 *     〇〇), 々 (repeat) and 〆 (shime).
 */
const KANJI = /[〇々〆㐀-䶿一-鿿\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;

/**
 * What a run may *contain* but never begin or end with: the full-size ケ カ ノ ツ that spell
 * 霞ケ関 (the Tokyo Metro spelling of Kasumigaseki), 一カ月, 一ノ瀬 and 四ツ谷, plus the small ヶ ヵ of
 * 三ヶ月 / 一ヵ月. Every one of them is also an ordinary katakana letter, which is why they are
 * admitted only with a true kanji on *both* sides — that is the whole of what keeps バケツ水 from
 * being read as the run ケツ水, and it costs only the (unattested) word that would end in one.
 *
 * So this class is deliberately not "every katakana": a single stray letter between two kanji is
 * the most it can ever absorb, and that shape is overwhelmingly one of these six.
 */
const KANJI_INTERIOR = /[ヵヶカケノツ]/u;

/**
 * The classes as a run, anchored: a reading sits over the kanji immediately before it. A run is a
 * kanji, then optionally more of either class and a closing kanji — so it both starts and ends
 * with a true kanji, and a trailing interior character is trimmed back off rather than ending it.
 * `exec` returns the leftmost match, which is this run at its maximal: the earliest kanji it can
 * start from, running to the end of `pending`.
 */
const KANJI_RUN = new RegExp(
  `${KANJI.source}(?:(?:${KANJI.source}|${KANJI_INTERIOR.source})*${KANJI.source})?$`,
  "u",
);
/** A reading group. The reading itself never contains a bracket, so it can't swallow the next one. */
const READING_GROUP = /《([^《》]*)》/gu;

/**
 * The base a reading belongs to: the maximal run of kanji that ends `pending`, and nothing else.
 * Empty when the group follows anything but kanji — the start of the string, kana, punctuation,
 * whitespace, or another group's base, which already carries a reading of its own — and the
 * reading is then dropped. The base has to be a *suffix* of `pending` (`parseFurigana` slices the
 * plain run off in front of it), so trimming a trailing ケ/ツ/ノ back off a run leaves nothing
 * touching the group and the reading is dropped for the same reason as any other non-kanji.
 *
 * Dropped rather than written over whatever character happens to precede it, because the backend
 * guarantees only that stripping every 《…》 group reproduces the translation
 * (`ClaudeTranslator#furigana_from`); nothing there says a group sits after kanji. A reading
 * measured against a word it isn't over is a lie in the one pane people are reading Japanese out
 * of — お願い《おねがい》します would put おねがい over い — and a missing reading is only a gap.
 * This is the rule `annotateTranslation` already applies to a base a gloss cut in two.
 */
function baseOf(pending: string): string {
  return KANJI_RUN.exec(pending)?.[0] ?? "";
}

/**
 * The annotated string as alternating plain and annotated runs. Every character that isn't part
 * of a 《…》 group survives exactly, newlines included, so the segments concatenate back to the
 * plain translation — which is what the user sees, selects and copies. Adjacent plain runs are
 * merged, and a group whose reading is empty or has nothing to sit over contributes no `<ruby>`
 * (its brackets still disappear, so no markup reaches the page).
 */
export function parseFurigana(annotated: string): RubySegment[] {
  const segments: RubySegment[] = [];
  // Plain text seen since the last segment was pushed: also the place a base is taken from.
  let pending = "";
  let cursor = 0;
  READING_GROUP.lastIndex = 0;
  for (let match = READING_GROUP.exec(annotated); match !== null; match = READING_GROUP.exec(annotated)) {
    pending += annotated.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const reading = match[1] ?? "";
    if (reading === "") continue;
    const base = baseOf(pending);
    if (base === "") continue;
    const plain = pending.slice(0, pending.length - base.length);
    if (plain !== "") segments.push({ text: plain });
    segments.push({ text: base, reading });
    pending = "";
  }
  pending += annotated.slice(cursor);
  if (pending !== "") segments.push({ text: pending });
  return segments;
}
