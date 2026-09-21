import { assertNever } from "./assertNever.ts";
import { formatWait } from "./formatWait.ts";
import type { RequestFailure } from "./requestFailure.ts";

/** A user-facing sentence for a request failure outside a mutation's typed errors. */
export function failureMessage(failure: RequestFailure): string {
  switch (failure.kind) {
    case "unauthenticated":
      return "Your session ended. Enter the access code again.";
    case "notFound":
      return "That no longer exists.";
    case "invalid":
      return failure.message ?? "That change isn't allowed.";
    case "rateLimited":
      return failure.retryAfterSeconds === null
        ? "Too many requests. Wait a few minutes and try again."
        : `Too many requests. Try again ${formatWait(failure.retryAfterSeconds)}.`;
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
