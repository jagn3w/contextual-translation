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
 * What a reading may be written over. A character left out of this class ends the run early, so the
 * reading after it lands over the wrong base (一ヵ月《いっかげつ》 would put いっかげつ over 月 alone),
 * which is why the class covers every block real Japanese puts under a reading:
 *   - CJK Unified Ideographs (一-鿿) and Extension A (㐀-䶿);
 *   - the compatibility ideographs (U+F900–U+FAFF), where the 﨑 of a name like 宮﨑 lives;
 *   - the astral extensions, B through the compatibility supplement (U+20000–U+2FA1F) — 𠮟, 𩸽 and
 *     most rare surname characters. The `u` flag is what makes this range match by code point;
 *   - the marks that only ever appear inside a kanji word: 〇 (the zero of 〇〇), 々 (repeat),
 *     〆 (shime) and the small ヵ/ヶ of 一ヵ月 / 三ヶ月.
 */
const KANJI = /[〇々〆ヵヶ㐀-䶿一-鿿\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
/** The same class as a run, anchored: a reading sits over the kanji immediately before it. */
const KANJI_RUN = new RegExp(`${KANJI.source}+$`, "u");
/** A reading group. The reading itself never contains a bracket, so it can't swallow the next one. */
const READING_GROUP = /《([^《》]*)》/gu;

/**
 * The base a reading belongs to: the maximal run of kanji that ends `pending`, and nothing else.
 * Empty when the group follows anything but kanji — the start of the string, kana, punctuation,
 * whitespace, or another group's base, which already carries a reading of its own — and the
 * reading is then dropped.
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
