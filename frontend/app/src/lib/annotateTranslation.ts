/**
 * Merges the two annotations the backend returns beside a translation — the furigana string and
 * the glosses — into the one list the result pane renders. A gloss is a tooltip wrapped around a
 * word that may itself contain ruby, so the two have to be interleaved before any markup exists:
 * this module does that, and keeps the code point arithmetic out of the component.
 */
import { hasKanji, parseFurigana, type RubySegment } from "./furigana.ts";

/**
 * A word of the translation with a short definition to show where the reader hovers it (design
 * D2.3). `startsAt` and `length` are counted in Unicode code points — what Ruby's String#length
 * counts on the backend, which is *not* what JS string indexing counts.
 */
export type Gloss = {
  text: string;
  reading: string | null;
  meaning: string;
  startsAt: number;
  length: number;
};

/** A piece of a run, becoming a `<ruby>` when it has a reading and a text node otherwise. */
export type RubyPart = { text: string; reading?: string };

/** A stretch of the translation: one hoverable word when it has a `gloss`, ordinary text when not. */
export type AnnotatedRun = { parts: RubyPart[]; gloss?: Gloss };

/** A half-open stretch of the translation in code points, and the gloss covering it if any. */
type Span = { from: number; to: number; gloss?: Gloss };

/** A furigana segment placed in the translation: its characters and where they start, in code points. */
type PlacedSegment = { characters: readonly string[]; reading?: string; from: number };

/**
 * The furigana parsed and positioned, or — with no furigana, or furigana that doesn't match the
 * translation — one unannotated segment covering the whole translation. The backend guarantees the
 * annotated string strips back to `text`, but a mismatch would slide every reading and every gloss
 * boundary out of place, so the guarantee is checked rather than trusted: the text the user reads
 * and copies matters more than the readings over it.
 */
function placedSegments(text: string, furigana: string | null): PlacedSegment[] {
  const parsed = furigana === null ? null : parseFurigana(furigana);
  const segments: RubySegment[] =
    parsed !== null && parsed.map((segment) => segment.text).join("") === text ? parsed : [{ text }];
  let at = 0;
  return segments.map((segment) => {
    const characters = Array.from(segment.text);
    const from = at;
    at += characters.length;
    return segment.reading === undefined
      ? { characters, from }
      : { characters, reading: segment.reading, from };
  });
}

/**
 * The translation cut into consecutive spans, one per gloss plus the plain text between them. A
 * gloss the renderer couldn't use is skipped rather than trusted: out of range, out of order
 * (which covers both an overlap with the previous gloss and a negative start), fractional, or
 * empty. Skipping only costs a tooltip — the span it would have covered still comes out as text.
 */
function spansOf(glosses: readonly Gloss[], length: number): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const gloss of glosses) {
    const from = gloss.startsAt;
    const to = from + gloss.length;
    if (!Number.isInteger(from) || !Number.isInteger(gloss.length)) continue;
    if (gloss.length <= 0 || from < cursor || to > length) continue;
    if (from > cursor) spans.push({ from: cursor, to: from });
    spans.push({ from, to, gloss });
    cursor = to;
  }
  if (cursor < length) spans.push({ from: cursor, to: length });
  return spans;
}

/**
 * Adjacent parts with no reading joined into one, so a gloss that swallows several kana segments
 * renders as a single text node instead of a string of empty spans.
 */
function merged(parts: readonly RubyPart[]): RubyPart[] {
  const compact: RubyPart[] = [];
  for (const part of parts) {
    const last = compact[compact.length - 1];
    if (part.reading === undefined && last !== undefined && last.reading === undefined) {
      last.text += part.text;
    } else {
      compact.push(part);
    }
  }
  return compact;
}

/**
 * The whole translation as consecutive runs, with each gloss its own run so the page can wrap it
 * in one tooltip, and the furigana carried along inside the runs so a glossed word can still show
 * ruby. Concatenating every part's text, in order, gives `text` back character for character.
 */
export function annotateTranslation(
  text: string,
  furigana: string | null,
  glosses: readonly Gloss[],
): AnnotatedRun[] {
  const length = Array.from(text).length;
  if (length === 0) return [];
  const segments = placedSegments(text, furigana);

  // Every part each segment contributed, in order, so a segment a gloss boundary cut in two can
  // decide what becomes of its reading once the cutting is done.
  const piecesOf: RubyPart[][] = segments.map(() => []);
  const runs: AnnotatedRun[] = [];
  for (const span of spansOf(glosses, length)) {
    const parts: RubyPart[] = [];
    segments.forEach((segment, index) => {
      const from = Math.max(span.from, segment.from);
      const to = Math.min(span.to, segment.from + segment.characters.length);
      if (to <= from) return;
      const part: RubyPart = {
        text: segment.characters.slice(from - segment.from, to - segment.from).join(""),
      };
      parts.push(part);
      piecesOf[index]?.push(part);
    });
    runs.push(span.gloss === undefined ? { parts } : { parts, gloss: span.gloss });
  }

  // A reading is only right over the kanji it was measured against. An unsplit segment has one
  // piece and simply keeps it; a split one has three cases:
  //   - exactly one piece kept kanji (天気 cut as 天|気です after a kana boundary, or 良い as 良|い):
  //     that piece is what the reading was measured against, so it carries it;
  //   - no piece kept kanji — the fake translator's "[JA]《ジェイエー》" (design D2.4), whose base is
  //     "]" — so the first piece carries it, exactly as the unsplit segment would have;
  //   - more than one piece kept kanji (東京駅《とうきょうえき》 glossed as 東京, cut 東京|駅): the
  //     reading belongs to the compound, not to either half, and there is no honest way to divide
  //     it. Giving it to the first piece would teach the reader that 東京 reads とうきょうえき, so
  //     the reading is dropped and both pieces render plain. A missing reading is a gap; a wrong
  //     one is a lie, and this pane is what someone is learning the word from.
  segments.forEach((segment, index) => {
    const reading = segment.reading;
    if (reading === undefined) return;
    const pieces = piecesOf[index] ?? [];
    const withKanji = pieces.filter((piece) => hasKanji(piece.text));
    if (withKanji.length > 1) return;
    const carrier = withKanji[0] ?? pieces[0];
    if (carrier !== undefined) carrier.reading = reading;
  });

  for (const run of runs) run.parts = merged(run.parts);
  return runs;
}
