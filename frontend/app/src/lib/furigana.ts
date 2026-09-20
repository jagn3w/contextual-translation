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
 * Whether anything in `text` can carry a reading. Exported for `annotateTranslation`, which splits
 * a segment when a gloss starts or ends inside it and has to decide which half keeps the reading;
 * it belongs here so "what counts as kanji" is defined once.
 */
export function hasKanji(text: string): boolean {
  return KANJI.test(text);
}

/** The last character of `text` as a user sees it, keeping an astral character's two units together. */
function trailingCharacter(text: string): string {
  const unit = text.charCodeAt(text.length - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && text.length >= 2 ? text.slice(-2) : text.slice(-1);
}

/**
 * The base a reading belongs to: the maximal run of kanji that ends `pending`, or — when the
 * group doesn't follow kanji at all — the single character before it. The fallback is what makes
 * the fake translator's "[JA]《ジェイエー》" (design D2.4) render as a ruby over "]" rather than
 * dropping the reading, and it costs nothing for real output, where a group always follows kanji.
 * Empty when nothing usable precedes the group: the start of the string, whitespace, or another
 * group's base, which already carries a reading of its own.
 */
function baseOf(pending: string): string {
  const kanji = KANJI_RUN.exec(pending);
  if (kanji !== null) return kanji[0];
  if (pending === "") return "";
  const last = trailingCharacter(pending);
  return /\s/u.test(last) ? "" : last;
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
