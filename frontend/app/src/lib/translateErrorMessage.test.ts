import type { TranslateErrorCode } from "../gql/graphql.ts";
import { translateErrorMessage } from "./translateErrorMessage.ts";

const CODES: TranslateErrorCode[] = [
  "EMPTY_INPUT", "INPUT_TOO_LONG", "SAME_LANGUAGE", "RATE_LIMITED", "TIMEOUT", "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_OVERLOADED", "UPSTREAM_ERROR", "UPSTREAM_UNREACHABLE", "BUDGET_EXCEEDED", "SERVICE_MISCONFIGURED",
  "REFUSED", "OUTPUT_TOO_LONG",
];

describe("translateErrorMessage", () => {
  it("gives every code its own message", () => {
    const messages = CODES.map((code) => translateErrorMessage(code, null));

    expect(new Set(messages).size).toBe(CODES.length);
  });

  it("includes the wait for rate limits", () => {
    expect(translateErrorMessage("RATE_LIMITED", 42)).toBe("You're translating quickly — try again in 42 seconds.");
    expect(translateErrorMessage("UPSTREAM_RATE_LIMITED", null)).toBe("Claude is busy — try again in a moment.");
  });
});
