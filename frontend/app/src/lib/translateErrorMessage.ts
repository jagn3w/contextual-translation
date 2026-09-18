import type { TranslateErrorCode } from "../gql/graphql.ts";
import { assertNever } from "./assertNever.ts";
import { formatWait } from "./formatWait.ts";

/**
 * The toast text for each typed translate error (design D3.3). Exhaustive: adding a code to the
 * GraphQL enum breaks the build until it has a message here.
 */
export function translateErrorMessage(
  code: TranslateErrorCode,
  retryAfterSeconds: number | null,
  serverMessage: string,
): string {
  const wait = retryAfterSeconds === null ? "in a moment" : formatWait(retryAfterSeconds);
  switch (code) {
    case "EMPTY_INPUT":
      return "Enter some text to translate.";
    case "INPUT_TOO_LONG":
      return "That's over the length limit (10,000 characters of text, 2,000 of context). Shorten it and try again.";
    case "SAME_LANGUAGE":
      return "The source and target languages are the same.";
    case "RATE_LIMITED":
      // The server names which limit it was (per minute, or today's cap for this device or code).
      return retryAfterSeconds !== null && retryAfterSeconds > 60
        ? `${serverMessage} It resets ${formatWait(retryAfterSeconds)}.`
        : serverMessage;
    case "TIMEOUT":
      return "The translation took too long. Try again, or shorten the text.";
    case "UPSTREAM_RATE_LIMITED":
      return `Claude is busy — try again ${wait}.`;
    case "UPSTREAM_OVERLOADED":
      return "Claude is temporarily overloaded. Try again shortly.";
    case "UPSTREAM_ERROR":
      return "Claude had a problem. Try again.";
    case "UPSTREAM_UNREACHABLE":
      return "Couldn't reach Claude. Try again.";
    case "BUDGET_EXCEEDED":
      return "This demo has reached its usage budget. Please let the owner know.";
    case "SERVICE_MISCONFIGURED":
      return "The translation service isn't configured correctly. Please let the owner know.";
    case "REFUSED":
      return "Claude declined to translate this text.";
    case "OUTPUT_TOO_LONG":
      return "The translation was too long to finish — try a shorter passage.";
    default:
      return assertNever(code);
  }
}
