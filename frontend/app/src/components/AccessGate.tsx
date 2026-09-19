import { type FormEvent, useId, useState } from "react";
import { assertNever } from "../lib/assertNever.ts";
import { failureMessage } from "../lib/failureMessage.ts";
import { formatWait } from "../lib/formatWait.ts";
import { signIn } from "../lib/session.ts";

type Props = {
  /** Shown above the form, e.g. when a session just ended. */
  notice?: string | undefined;
  onSignedIn: () => void;
};

/** The access-code screen (design D4.1, D4.2): one shared code, exchanged for a session cookie. */
export function AccessGate({ notice, onSignedIn }: Props) {
  const inputId = useId();
  const errorId = useId();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || code.trim() === "") return;
    setSubmitting(true);
    setError(null);
    const result = await signIn(code.trim());
    setSubmitting(false);
    if (result.ok) {
      onSignedIn();
      return;
    }
    const { reason } = result;
    if (reason === "invalidCode") {
      setError("That code didn't work. Check it and try again.");
    } else if (typeof reason === "object") {
      setError(
        reason.kind === "rateLimited" && reason.retryAfterSeconds !== null
          ? `Too many sign-in attempts. Try again ${formatWait(reason.retryAfterSeconds)}.`
          : failureMessage(reason),
      );
    } else {
      assertNever(reason);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-surface px-4">
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="w-full max-w-sm rounded-xl border border-line bg-canvas p-8 shadow-sm"
        noValidate
      >
        <h1 className="text-lg font-semibold tracking-tight">Contextual Translate</h1>
        <p className="mt-1 text-sm text-muted">Translation that understands where you are and who you're talking to.</p>

        {notice !== undefined && (
          <p role="status" className="mt-5 rounded-md bg-surface px-3 py-2 text-sm text-ink">
            {notice}
          </p>
        )}

        <label htmlFor={inputId} className="mt-6 block text-sm font-medium">
          Access code
        </label>
        <input
          id={inputId}
          name="code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ctx-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          className="mt-2 w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm tracking-wide placeholder:text-muted/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        {error !== null && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || code.trim() === ""}
          className="mt-6 w-full rounded-md bg-ink px-3 py-2 text-sm font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Checking…" : "Continue"}
        </button>
      </form>
    </main>
  );
}
