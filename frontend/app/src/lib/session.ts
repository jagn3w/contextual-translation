import { failureFromResponse, type RequestFailure } from "./requestFailure.ts";

/** The outcome of submitting an access code (design D3.1). */
export type SignInResult = { ok: true } | { ok: false; reason: "invalidCode" } | { ok: false; reason: RequestFailure };

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

export async function signIn(code: string): Promise<SignInResult> {
  let response: Response;
  try {
    response = await fetch("/api/session", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, reason: { kind: "network" } };
  }
  if (response.ok) return { ok: true };

  const bodyText = await response.text();
  // A wrong code is the ordinary case, not an "unauthenticated" session failure.
  if (response.status === 401) return { ok: false, reason: "invalidCode" };
  return { ok: false, reason: failureFromResponse(response.status, bodyText, response.headers.get("retry-after")) };
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/session", { method: "DELETE", headers: JSON_HEADERS, credentials: "same-origin" });
  } catch {
    // Signing out is best-effort: the client forgets the session either way.
  }
}
