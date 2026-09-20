import { useMutation } from "@apollo/client/react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { LanguageSelect } from "../components/LanguageSelect.tsx";
import { type Language, TranslateDocument, type TranslateMutation } from "../gql/graphql.ts";
import { failureMessage } from "../lib/failureMessage.ts";
import { parseFurigana } from "../lib/furigana.ts";
import { describeRequestError } from "../lib/requestFailure.ts";
import { translateErrorMessage } from "../lib/translateErrorMessage.ts";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea.ts";

type Props = {
  onSignOut: () => void;
};

/** A translation plus the inputs it was made from, so the page can tell when it's out of date. */
type Translation = NonNullable<TranslateMutation["translate"]["translation"]> & {
  fromText: string;
  fromContext: string;
};

/**
 * What one language holds, whichever pane it happens to be in (design MVP, D1.4). `target` is the
 * last text of this language Claude has seen — either what it returned in this language, or what
 * it was asked to translate out of it — and `input` is that text plus any edits made since.
 * Keeping the text with the language is what makes the swap button a pure exchange of language
 * codes, so swapping twice is exactly identity.
 */
type LanguageBuffer = { input: string; target: string };
type Buffers = Record<Language, LanguageBuffer>;

const EMPTY_BUFFERS: Buffers = {
  EN: { input: "", target: "" },
  ES: { input: "", target: "" },
  JA: { input: "", target: "" },
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


/** Length in Unicode code points — how the backend (Ruby String#length) counts the limits. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * Claude's Japanese with a reading over each run of kanji (design D2.3, design D1.4). `<ruby>`
 * keeps the translation itself as the pane's text, so what a user selects and copies is the plain
 * sentence: the 《…》 markup never reaches the DOM.
 */
function rubyText(annotated: string) {
  return parseFurigana(annotated).map((segment, index) =>
    segment.reading === undefined ? (
      segment.text
    ) : (
      // The segments are a pure function of one string, so the index is a stable identity.
      <ruby key={index}>
        {segment.text}
        <rt className="text-[0.5em] text-frame-muted">{segment.reading}</rt>
      </ruby>
    ),
  );
}

/** Seconds since `active` became true, ticking once a second; null when inactive. */
function useElapsedSeconds(active: boolean): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const started = useRef(0);
  useEffect(() => {
    if (!active) {
      setElapsed(null);
      return;
    }
    started.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

export const MAX_SOURCE_LENGTH = 10_000;
export const MAX_CONTEXT_LENGTH = 2_000;

/**
 * The translation workspace (design MVP, D1.4): the source pane (editable) and target pane
 * (read-only) side by side like Google Translate, each with a language picker and a swap button
 * between them; the context field and the Update Translation button below.
 */
export function TranslatePage({ onSignOut }: Props) {
  const sourceId = useId();
  const contextId = useId();
  const [sourceLanguage, setSourceLanguage] = useState<Language>("EN");
  // Japanese is the default target: the demo's showcase pair is English → Japanese (design MVP).
  const [targetLanguage, setTargetLanguage] = useState<Language>("JA");
  const [buffers, setBuffers] = useState<Buffers>(EMPTY_BUFFERS);
  const [context, setContext] = useState("");
  const [translation, setTranslation] = useState<Translation | null>(null);
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
  // Neither editable box scrolls: each grows with the text it holds (design D1.4), and the
  // result pane beside the source one is a plain div, so it has always grown.
  const sourceRef = useAutoGrowTextarea(sourceText);
  const contextRef = useAutoGrowTextarea(context);
  // What's on screen is up to date when it is still exactly the pair Claude last answered for —
  // in either direction, since a swap only exchanges the language codes — under the same context.
  const matchesLastResponse =
    translation !== null &&
    translation.fromContext === context &&
    ((sourceLanguage === translation.sourceLanguage &&
      targetLanguage === translation.targetLanguage &&
      sourceText === translation.fromText) ||
      (sourceLanguage === translation.targetLanguage &&
        targetLanguage === translation.sourceLanguage &&
        sourceText === translation.text));
  const stale = resultText !== "" && !matchesLastResponse;
  // Everything Claude sent *about* its answer — the notes, the readings — belongs to one response
  // in one direction. After a swap the result pane shows the text that was translated *from*,
  // which has none of that of its own, so the pane is plain text there.
  const showingResponseOutput =
    translation !== null &&
    sourceLanguage === translation.sourceLanguage &&
    targetLanguage === translation.targetLanguage &&
    resultText === translation.text;
  const responseNotes = showingResponseOutput ? translation.notes : null;
  // Null whenever the backend had no readings to give (design D2.3) — a non-Japanese target, or
  // Japanese it couldn't annotate — and the pane falls back to plain text.
  const responseFurigana = showingResponseOutput ? translation.furigana : null;
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
    // the pickers and textareas say by the time it lands.
    const sent = { text: sourceText, context, source: sourceLanguage, target: targetLanguage };
    try {
      const { data } = await translate({
        variables: {
          input: {
            sourceText: sent.text,
            sourceLanguage: sent.source,
            targetLanguage: sent.target,
            context: sent.context.trim() === "" ? null : sent.context,
          },
        },
      });
      if (!mounted.current) return;
      const payload = data?.translate;
      const error = payload?.errors[0];
      if (payload?.translation) {
        const result = payload.translation;
        setTranslation({ ...result, fromText: sent.text, fromContext: sent.context });
        // Throw out the dirty buffers on both sides of the pair: after a response both languages
        // are clean, so an immediate swap hands back an editable copy of the translation with the
        // text it came from waiting in the other pane. The third language keeps what it held.
        setBuffers((current) =>
          withBuffer(withBuffer(current, sent.source, { input: sent.text, target: sent.text }), sent.target, {
            input: result.text,
            target: result.text,
          }),
        );
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
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <h1 className="text-base font-semibold tracking-tight">Contextual Translate</h1>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface hover:text-ink"
        >
          Sign out
        </button>
      </header>

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
                className="rounded-full p-2 text-muted hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:opacity-40"
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
                className="block min-h-72 w-full resize-none overflow-hidden bg-canvas px-5 py-4 text-lg leading-relaxed placeholder:text-muted/60 focus:outline-none"
              />
              <p className={`px-5 pb-3 text-right text-xs ${sourceTooLong ? "text-danger" : "text-muted"}`}>
                {sourceTooLong && "Too long to translate — "}
                {sourceLength.toLocaleString()} / {MAX_SOURCE_LENGTH.toLocaleString()}
              </p>
            </div>

            <div
              className={`min-h-72 border-t border-line bg-frame px-5 py-4 md:border-t-0 ${stale ? "opacity-60" : ""}`}
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
                  {/* Ruby needs room above each line for the readings, so annotated text gets
                      looser leading than the plain paragraph, which keeps its usual rhythm. */}
                  <p className={`whitespace-pre-wrap text-lg ${responseFurigana === null ? "leading-relaxed" : "leading-loose"}`}>
                    {responseFurigana === null ? resultText : rubyText(responseFurigana)}
                  </p>
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
            {elapsed !== null && elapsed >= 2 ? `Asking Claude… ${elapsed}s` : "⌘/Ctrl + Enter"}
          </span>
          {/* Always mounted, so screen readers announce each change: start, result or failure. */}
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>
      </main>
    </div>
  );
}
