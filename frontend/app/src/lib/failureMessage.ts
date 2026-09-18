import { assertNever } from "./assertNever.ts";
import { formatWait } from "./formatWait.ts";
import type { RequestFailure } from "./requestFailure.ts";

/** A user-facing sentence for a request failure outside the typed translate errors (D3.3). */
export function failureMessage(failure: RequestFailure): string {
  switch (failure.kind) {
    case "unauthenticated":
      return "Your session ended. Enter the access code again.";
    case "rateLimited":
      return failure.retryAfterSeconds === null
        ? "Too many attempts. Wait a few minutes and try again."
        : `Too many attempts. Try again ${formatWait(failure.retryAfterSeconds)}.`;
    case "blocked":
      return "The request was blocked. Reload the page and try again.";
    case "payloadTooLarge":
      return "That's too much text to send at once. Shorten it and try again.";
    case "internal":
      return failure.reference === null
        ? "Something unexpected went wrong."
        : `Something unexpected went wrong (reference ${failure.reference}).`;
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    case "server":
      return `The server had a problem (HTTP ${failure.status}). Try again in a moment.`;
    default:
      return assertNever(failure);
  }
}
