import { useMutation } from "@apollo/client/react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { LanguageSelect } from "../components/LanguageSelect.tsx";
import { type Language, TranslateDocument, type TranslateMutation, type ViewerQuery } from "../gql/graphql.ts";
import { failureMessage } from "../lib/failureMessage.ts";
import { describeRequestError } from "../lib/requestFailure.ts";
import { translateErrorMessage } from "../lib/translateErrorMessage.ts";

type Props = {
  viewer: ViewerQuery["viewer"];
  onSignOut: () => void;
};

/** A translation plus the inputs it was made from, so the page can tell when it's out of date. */
type Translation = NonNullable<TranslateMutation["translate"]["translation"]> & {
  fromText: string;
  fromContext: string;
};

// Each attempt gets its own toast id: sonner merges an update into an existing toast, so reusing
// one id would let a retryable toast's "Try again" survive into a later, non-retryable error.
let toastCounter = 0;


/** Length in Unicode code points — how the backend (Ruby String#length) counts the limits. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
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
export function TranslatePage({ viewer, onSignOut }: Props) {
  const sourceId = useId();
  const contextId = useId();
  const [sourceLanguage, setSourceLanguage] = useState<Language>("EN");
  const [targetLanguage, setTargetLanguage] = useState<Language>("ES");
  const [sourceText, setSourceText] = useState("");
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

  const sourceEdited = translation !== null && translation.fromText !== sourceText;
  const stale =
    translation !== null &&
    (sourceEdited ||
      translation.fromContext !== context ||
      translation.sourceLanguage !== sourceLanguage ||
      translation.targetLanguage !== targetLanguage);
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

  // Like Google Translate: swap the languages and move the translation into the source pane.
  // The translation carries its own languages, so the text keeps the right label even if the
  // pickers changed after translating.
  function swap() {
    // Never overwrite text the user has typed since translating: swap only the languages.
    if (translation !== null && !sourceEdited) {
      setSourceLanguage(translation.targetLanguage);
      setTargetLanguage(translation.sourceLanguage);
      setSourceText(translation.text);
      setTranslation(null);
    } else {
      setSourceLanguage(targetLanguage);
      setTargetLanguage(sourceLanguage);
    }
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
    try {
      const { data } = await translate({
        variables: {
          input: { sourceText, sourceLanguage, targetLanguage, context: context.trim() === "" ? null : context },
        },
      });
      if (!mounted.current) return;
      const payload = data?.translate;
      const error = payload?.errors[0];
      if (payload?.translation) {
        setTranslation({ ...payload.translation, fromText: sourceText, fromContext: context });
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
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>{viewer.accessCodeLabel}</span>
          <button type="button" onClick={onSignOut} className="rounded-md px-2 py-1 hover:bg-surface hover:text-ink">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-16" onKeyDown={handleShortcut}>
        <section className="overflow-hidden rounded-xl border border-line" aria-label="Translation">
          <div className="grid grid-cols-1 border-b border-line md:grid-cols-[1fr_auto_1fr]">
            <div className="flex items-center px-3 py-2">
              <LanguageSelect label="Source language" value={sourceLanguage} onChange={chooseSource} />
            </div>
            <div className="flex items-center justify-center border-y border-line px-2 md:border-y-0">
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
            <div className="flex items-center px-3 py-2">
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
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                aria-invalid={sourceTooLong}
                placeholder="Type or paste text…"
                className="block min-h-72 w-full resize-y bg-canvas px-5 py-4 text-lg leading-relaxed placeholder:text-muted/60 focus:outline-none"
              />
              <p className={`px-5 pb-3 text-right text-xs ${sourceTooLong ? "text-danger" : "text-muted"}`}>
                {sourceTooLong && "Too long to translate — "}
                {sourceLength.toLocaleString()} / {MAX_SOURCE_LENGTH.toLocaleString()}
              </p>
            </div>

            <div
              className={`min-h-72 border-t border-line bg-surface/60 px-5 py-4 md:border-t-0 ${stale ? "opacity-60" : ""}`}
              aria-label="Translation result"
              aria-busy={loading}
              role="region"
            >
              {loading ? (
                <div className="space-y-3" aria-hidden>
                  <div className="h-5 w-3/4 animate-pulse rounded bg-line" />
                  <div className="h-5 w-1/2 animate-pulse rounded bg-line" />
                  <div className="h-5 w-2/3 animate-pulse rounded bg-line" />
                </div>
              ) : translation === null ? (
                <p className="text-lg text-muted/70">Translation</p>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-lg leading-relaxed">{translation.text}</p>
                  {translation.notes && (
                    <p className="mt-4 border-t border-line pt-3 text-sm text-muted">
                      <span className="font-medium text-ink/80">Claude's note: </span>
                      {translation.notes}
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
            value={context}
            onChange={(event) => setContext(event.target.value)}
            aria-invalid={contextTooLong}
            rows={3}
            placeholder="Describe the situation, formality or region…"
            className="mt-2 block w-full resize-y rounded-lg border border-line bg-canvas px-4 py-3 text-sm leading-relaxed placeholder:text-muted/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
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
