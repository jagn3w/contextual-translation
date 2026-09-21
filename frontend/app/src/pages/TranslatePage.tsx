import { useMutation } from "@apollo/client/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Fragment, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { GlossLevelSelect } from "../components/GlossLevelSelect.tsx";
import { GlossedWord } from "../components/GlossedWord.tsx";
import { LanguageSelect } from "../components/LanguageSelect.tsx";
import { type GlossLevel, type Language, TranslateDocument, type TranslateMutation } from "../gql/graphql.ts";
import { annotateTranslation, type Gloss, type RubyPart } from "../lib/annotateTranslation.ts";
import { codePointLength } from "../lib/codePoints.ts";
import { failureMessage } from "../lib/failureMessage.ts";
import { describeRequestError } from "../lib/requestFailure.ts";
import { translateErrorMessage } from "../lib/translateErrorMessage.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";
import { askingClaude, useElapsedSeconds } from "../lib/useElapsedSeconds.ts";

/** A translation plus the inputs it was made from, so the page can tell when it's out of date. */
type Translation = NonNullable<TranslateMutation["translate"]["translation"]> & {
  fromText: string;
  fromContext: string;
  fromGlossLevel: GlossLevel;
};

/**
 * What one language holds, whichever pane it happens to be in (design MVP, D1.4). `target` is the
 * last text of this language Claude has seen — either what it returned in this language, or what
 * it was asked to translate out of it — and `input` is that text plus any edits made since.
 * Keeping the text with the language is what makes the swap button a pure exchange of language
 * codes, so swapping twice is exactly identity.
 *
 * The answers that response put that `target` there live here too — with the text — for the same
 * reason the text does. Everything Claude sends *about* an answer (the readings, the definitions,
 * the note, the shortfall flags) describes one particular stretch of one particular language, so
 * it has to travel with that stretch or it is lost the moment anything else is translated. Held in
 * a single page-wide slot it was: translate EN→JA, switch the target to Spanish, translate EN→ES,
 * switch back — the Japanese is still sitting in its buffer, unchanged and still the answer to the
 * same source, context and level, but its furigana and its note had been overwritten by the
 * Spanish answer and the pane marked it out of date besides, pushing the reader into a
 * re-translate against the per-session translation limits (RateLimiter::SESSION_LIMITS,
 * design D3.4) for text that had not changed.
 *
 * Both languages of a pair record the answer, because both are needed later: the one that received
 * the translation, so the ruby and the note can be put back over it, and the one it was translated
 * out of, so a swapped pane can still tell it is looking at the pair Claude answered. They are two
 * separate slots rather than one, because a language plays both roles in turn and each role's
 * answer stays true for a different reason. `answerInto` is the answer that *wrote* this language's
 * `target`, and it is the only one that may speak about that text — the readings are over it, the
 * gloss offsets are into it, the note is about it. `answerOutOf` is the answer that was made *from*
 * this language's `target`; it says nothing about the text itself, only that this text was what
 * Claude was handed.
 *
 * One slot for both was the bug: a JA→EN answer landed in Japanese's only slot and evicted the
 * EN→JA answer whose furigana was over the very same, byte-for-byte unchanged Japanese. Swap,
 * Update Translation, swap back and the Japanese pane repainted itself bare — no ruby, no glosses,
 * no note — while `matchesLastResponse` still recognised the swapped pair and so painted it up to
 * date, i.e. claiming to be current while showing strictly less than it had three clicks earlier.
 * With a slot per role neither answer can evict the other, and an annotation is dropped only when
 * the text it describes actually changes: `showingResponseOutput` compares `answerInto.text` with
 * what the pane is showing, which is what the source-role write-back moves out from under it.
 *
 * Which slot an answer sits in *is* the role it played, so `answerInto.targetLanguage` is always
 * this language and `answerOutOf.sourceLanguage` always is too. Nothing re-derives a role from the
 * payload; that read-it-back-off-the-answer test is what the eviction above used to defeat.
 */
type LanguageBuffer = {
  input: string;
  target: string;
  answerInto: Translation | null;
  answerOutOf: Translation | null;
};
type Buffers = Record<Language, LanguageBuffer>;

const EMPTY_BUFFERS: Buffers = {
  EN: { input: "", target: "", answerInto: null, answerOutOf: null },
  ES: { input: "", target: "", answerInto: null, answerOutOf: null },
  JA: { input: "", target: "", answerInto: null, answerOutOf: null },
};

/** The buffers with one language replaced; every other language keeps the text it was holding. */
function withBuffer(buffers: Buffers, language: Language, buffer: LanguageBuffer): Buffers {
  const next = { ...buffers };
  next[language] = buffer;
  return next;
}

// Each attempt gets its own toast id: sonner merges an update into an existing toast, so reusing
// one id would let a retryable toast's "Try again" survive into a later, non-retryable error.
let toastCounter = 0;


/** A response with nothing to gloss, with a stable identity so the annotation memo holds. */
const NO_GLOSSES: readonly Gloss[] = [];

/**
 * One run's text, with a reading over each run of kanji (design D2.3, design D1.4). `<ruby>` keeps
 * the translation itself as the pane's text — the 《…》 markup never reaches the DOM — and the
 * readings are marked `select-none`, which is what keeps them out of a copy: a browser folds `<rt>`
 * text into a plain-text copy, so without it copying 今日は良い天気ですね would paste
 * 今日きょうは良よい天気てんきですね into the email the user came here to write.
 *
 * `aria-hidden` is that same sentence said to a screen reader, and it is decided here — once, for
 * every reading the pane renders — rather than per widget. Chrome and Firefox expose `<rt>` as
 * static text, so the accessible name of the paragraph is the fold: NVDA and VoiceOver announce
 * 今日きょうは良よい天気てんきですね, the reading run into the word every time. `select-none` is
 * no help there; it styles a copy and says nothing about a name. Hiding the readings from the
 * accessibility tree leaves the announced sentence as the translation itself, which is what this
 * pane is for, and loses nothing: a reading is still on the gloss card beside its word, where a
 * reader asks for one word at a time. That one decision is also why GlossedWord.tsx no longer
 * carries an `aria-label` — with the `<rt>` inside it hidden, its name from contents *is* the word.
 *
 * What is guaranteed, then: a selection dragged across the pane covers the plain sentence, the
 * plain text on the clipboard is the translation alone, and so is what a screen reader reads out.
 * Nothing here governs a "copy as HTML" or a screenshot, which carry the ruby markup and the
 * readings along by design.
 */
function rubyParts(parts: readonly RubyPart[]) {
  return parts.map((part, index) =>
    part.reading === undefined ? (
      part.text
    ) : (
      // The parts are a pure function of one response, so the index is a stable identity.
      <ruby key={index}>
        {part.text}
        <rt aria-hidden className="select-none text-[0.5em] text-frame-muted">
          {part.reading}
        </rt>
      </ruby>
    ),
  );
}

export const MAX_SOURCE_LENGTH = 10_000;
export const MAX_CONTEXT_LENGTH = 2_000;

/**
 * The translation workspace (design MVP, D1.4): the source pane (editable) and target pane
 * (read-only) side by side like Google Translate, each with a language picker and a swap button
 * between them; the context field and the Update Translation button below.
 */
export function TranslatePage() {
  const sourceId = useId();
  const contextId = useId();
  const [sourceLanguage, setSourceLanguage] = useState<Language>("EN");
  // Japanese is the default target: the demo's showcase pair is English → Japanese (design MVP).
  const [targetLanguage, setTargetLanguage] = useState<Language>("JA");
  const [buffers, setBuffers] = useState<Buffers>(EMPTY_BUFFERS);
  const [context, setContext] = useState("");
  // Notable words is the default the backend documents, repeated here so the first request states
  // it rather than relying on the schema default (design D2.3).
  const [glossLevel, setGlossLevel] = useState<GlossLevel>("NOTABLE");
  const [translate, { loading }] = useMutation(TranslateDocument);
  const elapsed = useElapsedSeconds(loading);
  // Guards against double submits between the click and the re-render that disables the button.
  const inFlight = useRef(false);
  // Toast actions call the latest runTranslation, never one captured with outdated inputs.
  const runLatest = useRef<() => Promise<void>>(async () => undefined);

  // A pending error toast (and its Try again) must not outlive the page, e.g. after sign-out.
  // A response that arrives after the page is gone (e.g. sign-out mid-request) is dropped.
  const mounted = useRef(true);
  const lastToastId = useRef<string | null>(null);
  useEffect(() => {
    // Set on every mount: StrictMode (dev) mounts, cleans up and mounts again with the same refs.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (lastToastId.current !== null) toast.dismiss(lastToastId.current);
    };
  }, []);
  // Screen-reader announcements: one always-mounted live region, updated per request.
  const [announcement, setAnnouncement] = useState("");

  // The panes are just a view of the two buffers: the source pane edits its language's `input`,
  // the result pane shows the other language's `target`.
  const sourceText = buffers[sourceLanguage].input;
  const resultText = buffers[targetLanguage].target;
  // The one response this pane is a view of: the one that last wrote the text it is showing. It is
  // read from the pane's own buffer rather than from a page-wide "last translation", so an answer
  // in another direction cannot speak for — or about — the text sitting here (see LanguageBuffer).
  const answer = buffers[targetLanguage].answerInto;
  // And the answer that was made *from* the text in this pane, which is a different fact about the
  // same language and so has a slot of its own. It is what a swapped pair is judged against: it
  // never describes the text on screen, so it is kept away from the annotations below.
  const answerOutOf = buffers[targetLanguage].answerOutOf;
  // Neither editable box scrolls: each grows with the text it holds (design D1.4), and the
  // result pane beside the source one is a plain div, so it has always grown.
  const sourceRef = useAutoGrowTextarea(sourceText);
  const contextRef = useAutoGrowTextarea(context);
  // What's on screen is up to date when it is still exactly the pair Claude answered for to put it
  // there — in either direction, since a swap only exchanges the language codes — under the same
  // context. The gloss level is an input to the answer like the context is — Claude picks the words
  // and writes the definitions — so changing it dates the result on screen instead of re-glossing
  // it. A Japanese pane is judged against the answers that involved the Japanese, not against
  // whatever was translated most recently.
  //
  // Two ways to be current, one per role, and each asks about *both* boxes rather than only the
  // editable one. Unswapped: the pane is showing this answer's output and the source box still
  // holds what it was made from. Swapped: the pane is showing the text this answer was made from
  // and the source box holds what it produced. The half naming the result pane is what the single
  // shared slot used to give for free — text and answer were written together, so the text could
  // not drift from the answer beside it. With a slot per role the two can be written by different
  // responses, so the freshness test says out loud what it needs of the text it is vouching for.
  const matchesLastResponse =
    (answer !== null &&
      answer.fromContext === context &&
      answer.fromGlossLevel === glossLevel &&
      sourceLanguage === answer.sourceLanguage &&
      sourceText === answer.fromText &&
      resultText === answer.text) ||
    (answerOutOf !== null &&
      answerOutOf.fromContext === context &&
      answerOutOf.fromGlossLevel === glossLevel &&
      sourceLanguage === answerOutOf.targetLanguage &&
      sourceText === answerOutOf.text &&
      resultText === answerOutOf.fromText);
  const stale = resultText !== "" && !matchesLastResponse;
  // Everything Claude sent *about* its answer — the notes, the readings, the definitions — belongs
  // to the text it answered *with*, and stays true for exactly as long as that text is on screen in
  // the language it was written in. So the predicate keys on the pane's own text and its language,
  // and not on the source picker: moving that picker changes nothing about the Japanese sitting
  // there, and stripping its ruby off would lose information rather than protect anyone. After a
  // swap the pane shows the text that was translated *from*, which has none of this of its own —
  // the target language no longer matches, so the pane is plain text there, as before. The answer
  // it asks is that language's own, so a translation in some other direction can no longer silence
  // it: the Japanese and everything Claude said about the Japanese leave together or not at all.
  //
  // The notes ride on the same rule rather than keeping the old full-direction test. A note is
  // Claude's commentary on the answer that is still visible ("Baseball bat; plain form."), so
  // hiding it would withhold a fact about text that has not changed; and two predicates for one
  // response is a trap for whoever edits this next. That the pickers have moved on is `stale`'s
  // job — and `stale` now says so in words, so a note read under a changed direction is read with
  // the "Out of date" marker already beside it.
  //
  // One test, and it is about the text alone: does the pane still show the very characters this
  // answer produced? The language no longer needs asking, `answerInto` being by construction an
  // answer *into* this language (see LanguageBuffer) — and it used to be asked of an answer that
  // could have been the source-role one, which is how a pane of unchanged Japanese lost its ruby.
  const showingResponseOutput = answer !== null && resultText === answer.text;
  const responseNotes = showingResponseOutput ? answer.notes : null;
  // Null whenever the backend had no readings to give (design D2.3) — a non-Japanese target, or
  // Japanese it couldn't annotate — and the pane falls back to plain text.
  const responseFurigana = showingResponseOutput ? answer.furigana : null;
  // Likewise the glosses: they are offsets into *this* response's text and mean nothing over any
  // other (design D2.3).
  const responseGlosses = showingResponseOutput ? answer.glosses : NO_GLOSSES;
  // Claude stopped glossing before the translation ended, so the reader is told rather than left
  // to conclude the untouched half of the sentence held nothing worth defining.
  const glossesTruncated = showingResponseOutput && answer.glossesTruncated;
  // The target was Japanese and no readings came back with it (design D2.3). The backend sets this
  // for every way that can happen — the length gate never asked for them, or what came back was
  // rejected (a translation carrying literal 《…》 punctuation, readings that failed validation) —
  // and does not say which, so neither may this pane. Same reason to say so whichever it was: with
  // nothing on screen to distinguish it, a pane of bare Japanese reads as "Claude found no kanji
  // here" rather than "you didn't get this part" — and the definitions, which none of those causes
  // touches, are still there implying the answer was annotated. Both flags ride on
  // `showingResponseOutput`, so neither can end up describing a response the pane has stopped
  // showing.
  const readingsOmitted = showingResponseOutput && answer.readingsOmitted;
  // What this answer didn't carry, in one paragraph rather than a stack of notices. The two are
  // unrelated — a per-answer cap on entries is what runs out for the definitions, and has nothing
  // to do with why the readings aren't here — so they stay separate sentences instead of being
  // merged into one claim, but they are one thing to tell the reader: this is annotated less than
  // the pane implies.
  const shortfalls: string[] = [];
  // Two things to say and no third. First: this answer has no readings over it — which is all the
  // flag knows, so naming a cause the pane can't see ("the text was too long", as this read until
  // the flag widened past the length gate) would be a guess printed as fact. Second, and the reason
  // the sentence exists at all: it is not that the Japanese has no kanji to read. Bare Japanese
  // looks exactly the same either way, so without the denial the reader concludes the kinder,
  // wronger thing and never learns something was missing.
  //
  // "over the translation" is load-bearing, not padding. Whatever dropped the furigana leaves the
  // glosses alone — `gloss_from` keeps each gloss's `reading` for any Japanese target — so in this
  // very pane, under this very notice, hovering a defined word still shows its kana. The sentence
  // therefore claims only what was actually given up, the ruby over the translation, and stops:
  // "this translation has none" read as a claim about the whole answer, and was contradicted by the
  // first word the reader hovered.
  if (readingsOmitted) {
    shortfalls.push(
      "No kana readings came with this answer, so there are none over the translation. It isn't that the Japanese has no kanji to read.",
    );
  }
  if (glossesTruncated) {
    shortfalls.push(
      `Definitions stop partway: ${responseGlosses.length} words are defined and the rest of the translation is not.`,
    );
  }
  // Null when there is nothing to annotate, which keeps the plain, un-wrapped text node the pane
  // has always rendered for a response with neither readings nor glosses.
  const annotated = useMemo(
    () =>
      responseFurigana === null && responseGlosses.length === 0
        ? null
        : annotateTranslation(resultText, responseFurigana, responseGlosses),
    [resultText, responseFurigana, responseGlosses],
  );
  const sourceLength = codePointLength(sourceText);
  const contextLength = codePointLength(context);
  const sourceTooLong = sourceLength > MAX_SOURCE_LENGTH;
  const contextTooLong = contextLength > MAX_CONTEXT_LENGTH;
  const canTranslate =
    !loading && sourceText.trim() !== "" && sourceLanguage !== targetLanguage && !sourceTooLong && !contextTooLong;

  function chooseSource(language: Language) {
    if (language === targetLanguage) setTargetLanguage(sourceLanguage);
    setSourceLanguage(language);
  }

  function chooseTarget(language: Language) {
    if (language === sourceLanguage) setSourceLanguage(targetLanguage);
    setTargetLanguage(language);
  }

  // Like Google Translate, the swap button puts the translation in the editable pane — but it does
  // so by exchanging the language codes alone: each language's text follows it between the panes,
  // nothing is moved or dropped, so swapping twice lands back on an identical state.
  function swap() {
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
  }

  function editSource(text: string) {
    setBuffers((current) => withBuffer(current, sourceLanguage, { ...current[sourceLanguage], input: text }));
  }

  async function runTranslation() {
    if (!canTranslate || inFlight.current) return;
    inFlight.current = true;
    if (lastToastId.current !== null) toast.dismiss(lastToastId.current);
    toastCounter += 1;
    const toastId = `translate-error-${toastCounter}`;
    lastToastId.current = toastId;
    setAnnouncement("Translating…");
    const retry = { label: "Try again", onClick: () => void runLatest.current() };
    // The request's own inputs: the response is written back against these, never against whatever
    // the pickers and textareas say by the time it lands. `targetInput` is not sent anywhere — it
    // is what the target language's own box held as the request went out, which is what lets the
    // write-back below tell an old draft it may replace from one typed since (see there).
    const sent = {
      text: sourceText,
      context,
      source: sourceLanguage,
      target: targetLanguage,
      glossLevel,
      targetInput: buffers[targetLanguage].input,
    };
    try {
      const { data } = await translate({
        variables: {
          input: {
            sourceText: sent.text,
            sourceLanguage: sent.source,
            targetLanguage: sent.target,
            context: sent.context.trim() === "" ? null : sent.context,
            glossLevel: sent.glossLevel,
          },
        },
      });
      if (!mounted.current) return;
      const payload = data?.translate;
      const error = payload?.errors[0];
      if (payload?.translation) {
        const result = payload.translation;
        // The answer together with the inputs it was made from, so `matchesLastResponse` can ask
        // later whether the pickers, the source box, the context and the level still say what they
        // said here. It is `sent`, never the live state: the pickers and both textareas stayed
        // editable for the whole call.
        const settled: Translation = {
          ...result,
          fromText: sent.text,
          fromContext: sent.context,
          fromGlossLevel: sent.glossLevel,
        };
        // Settle both sides of the pair, so an immediate swap hands back an editable copy of the
        // translation with the text it came from waiting in the other pane. The third language
        // keeps what it held — including its own `answer`, which is the point: a Japanese pane
        // annotated an hour ago is still annotated after a translation into Spanish.
        setBuffers((current) => {
          // The source's `input` is left exactly as it stands, which resets it only in the case
          // where resetting is a no-op. Nothing typed during the request → it is already
          // `sent.text`, clean, and the swap above is exact. Something typed → it is a draft, and
          // the box was editable the whole 5–20s the call took, so people do type there; writing
          // `sent.text` back over it would destroy that work silently and with no undo, the
          // <textarea> being controlled. The result then reads as out of date beside the draft,
          // which is precisely what it is. So: never overwrite a changed source box.
          //
          // The same rule on the far side, which needs the test spelled out because that box is
          // usually — not always — the read-only pane. The language pickers stay live for the
          // whole call (only the swap and submit buttons go disabled), so choosing the target
          // language as the source swaps the pair mid-flight and makes that very box the editable
          // one; whatever is typed there is a draft with no undo, exactly like the source's. So
          // `input` is replaced only when it still holds what it held when the request went out.
          // That still throws out an *old* target-language draft, which is the intended reset —
          // it is only text typed since the request that is protected. The result then reads as
          // out of date beside the draft, `stale` keying on the pane's text rather than on this.
          //
          // `target` is not a draft but a record of the text of this language Claude has now seen,
          // so it is written on both sides unconditionally — and this answer is recorded on both
          // sides too, each in the slot for the role the language played here (see LanguageBuffer).
          // The source side's record is what keeps a swapped pane up to date: after the swap that
          // pane shows this language's `target`, which is exactly what Claude was handed.
          //
          // Each side writes its own slot and leaves the other alone, which is the fix: the
          // language being translated *out of* here may be holding, in `answerInto`, the answer
          // that put its text there in the first place — furigana, glosses and all — and this
          // answer is no evidence against that one. It is only evidence about text, so the pane
          // checks the text: if this request's `sent.text` is not what that older answer returned,
          // `showingResponseOutput` sees the mismatch and drops the annotation by itself. The
          // unconditional replace that used to stand here threw the annotation away even when
          // `target` came out byte-for-byte identical, which is precisely when it was still true.
          const source = current[sent.source];
          const target = current[sent.target];
          return withBuffer(
            withBuffer(current, sent.source, { ...source, target: sent.text, answerOutOf: settled }),
            sent.target,
            {
              ...target,
              input: target.input === sent.targetInput ? result.text : target.input,
              target: result.text,
              answerInto: settled,
            },
          );
        });
        setAnnouncement("Translation ready.");
      } else if (error !== undefined) {
        // Typed, anticipated failures (design D3.3): one message per code. Try again is offered
        // only when retrying now could work: with a known wait, the message states it instead,
        // and an early click would just be refused and count against the limits.
        const retryAfter = error.retryAfterSeconds ?? null;
        const offerRetry = error.retryable && (retryAfter === null || retryAfter <= 0);
        const message = translateErrorMessage(error.code, retryAfter, error.message);
        setAnnouncement("Translation failed."); // the toast itself is announced by sonner
        toast.error(message, { id: toastId, ...(offerRetry ? { action: retry } : {}) });
      }
    } catch (caught) {
      if (!mounted.current) return;
      const failure = describeRequestError(caught);
      // An ended session is handled by the app, which returns to the access-code screen.
      if (failure.kind === "unauthenticated") return;
      const retryable = failure.kind === "network" || failure.kind === "server" || failure.kind === "internal";
      setAnnouncement("Translation failed.");
      toast.error(failureMessage(failure), { id: toastId, ...(retryable ? { action: retry } : {}) });
    } finally {
      inFlight.current = false;
    }
  }
  runLatest.current = runTranslation;

  function handleShortcut(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void runTranslation();
    }
  }

  return (
    // One provider for every glossed word, with a short delay: the definitions are meant to be
    // skimmed while reading, so a tooltip that waits feels broken (design D2.3).
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      <main className="mx-auto max-w-6xl px-6 pb-16" onKeyDown={handleShortcut}>
        <section className="overflow-hidden rounded-xl border border-line" aria-label="Translation">
          {/* One row at every width, phones included: minmax(0,1fr) lets the two picker cells
              shrink past their text (a bare 1fr floors at its content and would overflow ~360px),
              and the equal side columns leave the swap button dead centre between them. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] border-b border-line">
            <div className="flex min-w-0 items-center px-3 py-2">
              <LanguageSelect label="Source language" value={sourceLanguage} onChange={chooseSource} />
            </div>
            <div className="flex items-center justify-center px-2">
              <button
                type="button"
                onClick={swap}
                disabled={loading}
                aria-label="Swap languages"
                title="Swap languages"
                className="focus-ring rounded-full p-2 text-muted hover:bg-surface hover:text-ink disabled:opacity-40"
              >
                ⇄
              </button>
            </div>
            <div className="flex min-w-0 items-center px-3 py-2">
              <LanguageSelect label="Target language" value={targetLanguage} onChange={chooseTarget} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-line">
            <div className="relative">
              <label htmlFor={sourceId} className="sr-only">
                Text to translate
              </label>
              <textarea
                id={sourceId}
                ref={sourceRef}
                value={sourceText}
                onChange={(event) => editSource(event.target.value)}
                aria-invalid={sourceTooLong}
                placeholder="Type or paste text…"
                // The pane grows with the text (design D1.4) but stops at roughly two thirds of
                // the viewport and scrolls from there, so the gloss picker, the counter and Update
                // Translation below it stay on screen. A 10,000-character paste is inside the
                // limit and would otherwise put them ~10,000px down — and past the limit the
                // button is disabled with the only explanation ("Too long to translate — …")
                // down there with it. The hook reads this number off the element rather than
                // holding its own copy, so the ceiling lives here with the rest of the layout.
                className="focus-ring block max-h-[65vh] min-h-72 w-full resize-none overflow-hidden bg-canvas px-5 py-4 text-lg leading-relaxed placeholder:text-muted/60"
              />
              {/* The request's two quiet settings live where the text is typed: the picker on the
                  left, the count keeping its right edge. */}
              <div className="flex items-center justify-between gap-3 px-5 pb-3">
                <GlossLevelSelect value={glossLevel} onChange={setGlossLevel} />
                <p className={`text-right text-xs ${sourceTooLong ? "text-danger" : "text-muted"}`}>
                  {sourceTooLong && "Too long to translate — "}
                  {sourceLength.toLocaleString()} / {MAX_SOURCE_LENGTH.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Out of date is said by the ground and by a marker, never by dimming the ink: a
                blanket opacity over the darkened frame composited the translation to 3.5:1,
                under WCAG AA. On bg-frame-stale the text is unchanged at 9.6:1 (design D1.4). */}
            <div
              className={`min-h-72 border-t border-line px-5 py-4 md:border-t-0 ${stale ? "bg-frame-stale" : "bg-frame"}`}
              aria-label="Translation result"
              aria-busy={loading}
              role="region"
            >
              {loading ? (
                // bg-line would vanish against the frame; a wash of ink keeps the bars readable there.
                <div className="space-y-3" aria-hidden>
                  <div className="h-5 w-3/4 animate-pulse rounded bg-ink/10" />
                  <div className="h-5 w-1/2 animate-pulse rounded bg-ink/10" />
                  <div className="h-5 w-2/3 animate-pulse rounded bg-ink/10" />
                </div>
              ) : resultText === "" ? (
                <p className="text-lg text-frame-muted">Translation</p>
              ) : (
                <>
                  {stale && (
                    // Named, not merely shaded: the tint alone is easy to miss, and "the text is
                    // greyed out" is exactly the misreading the old blanket opacity invited.
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-frame-muted">Out of date</p>
                  )}
                  {/* Ruby needs room above each line for the readings, so annotated text gets
                      looser leading than the plain paragraph, which keeps its usual rhythm. */}
                  <p className={`whitespace-pre-wrap text-lg ${responseFurigana === null ? "leading-relaxed" : "leading-loose"}`}>
                    {annotated === null
                      ? resultText
                      : annotated.map((run, index) =>
                          run.gloss === undefined ? (
                            // Runs are a pure function of one response, so the index is stable.
                            <Fragment key={index}>{rubyParts(run.parts)}</Fragment>
                          ) : (
                            <GlossedWord key={index} gloss={run.gloss}>
                              {rubyParts(run.parts)}
                            </GlossedWord>
                          ),
                        )}
                  </p>
                  {/* What ran out for the definitions is a fixed cap on how many one answer may
                      carry, not room in the answer and not the length of the translation, so the
                      message says how many arrived and stops there. The number is counted from
                      the response in hand rather than copied from the backend's cap, which would
                      be a second constant on this side of the boundary, free to drift. */}
                  {shortfalls.length > 0 && (
                    <p className="mt-4 text-xs text-frame-muted">{shortfalls.join(" ")}</p>
                  )}
                  {responseNotes && (
                    <p className="mt-4 border-t border-ink/10 pt-3 text-sm text-frame-muted">
                      <span className="font-medium text-ink/80">Note: </span>
                      {responseNotes}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </section>

        <div className="mt-6">
          <label htmlFor={contextId} className="block text-sm font-medium">
            Context
          </label>
          <p className="mt-0.5 text-sm text-muted">
            Where are you, and who are you talking to? E.g. "At a baseball game" or "An email to my new manager in
            Madrid".
          </p>
          <textarea
            id={contextId}
            ref={contextRef}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            aria-invalid={contextTooLong}
            rows={3}
            placeholder="Describe the situation, formality or region…"
            className="mt-2 block min-h-24 w-full resize-none overflow-hidden rounded-lg border border-line bg-canvas px-4 py-3 text-sm leading-relaxed placeholder:text-muted/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
          {contextTooLong && (
            <p className="mt-1 text-xs text-danger">
              Context is too long — {contextLength.toLocaleString()} / {MAX_CONTEXT_LENGTH.toLocaleString()} characters.
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runTranslation()}
            disabled={!canTranslate}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Translating…" : "Update Translation"}
          </button>
          <span className="text-xs text-muted">
            {askingClaude(elapsed) ?? "⌘/Ctrl + Enter"}
          </span>
          {/* Always mounted, so screen readers announce each change: start, result or failure. */}
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>
      </main>
    </Tooltip.Provider>
  );
}
