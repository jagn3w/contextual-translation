import type { TranslateErrorCode } from "../gql/graphql.ts";
import { translateErrorMessage } from "./translateErrorMessage.ts";

const CODES: TranslateErrorCode[] = [
  "EMPTY_INPUT", "INPUT_TOO_LONG", "SAME_LANGUAGE", "RATE_LIMITED", "TIMEOUT", "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_OVERLOADED", "UPSTREAM_ERROR", "UPSTREAM_UNREACHABLE", "BUDGET_EXCEEDED", "SERVICE_MISCONFIGURED",
  "REFUSED", "OUTPUT_TOO_LONG",
];

describe("translateErrorMessage", () => {
  it("gives every code its own message", () => {
    const messages = CODES.map((code) => translateErrorMessage(code, null, `server says ${code}`));

    expect(new Set(messages).size).toBe(CODES.length);
  });

  it("uses the server's per-limit message for our rate limits, adding long waits", () => {
    expect(translateErrorMessage("RATE_LIMITED", 42, "You're translating quickly.")).toBe(
      "You're translating quickly. Try again in 42 seconds.",
    );
    expect(translateErrorMessage("RATE_LIMITED", null, "You're translating quickly.")).toBe("You're translating quickly.");
    expect(translateErrorMessage("RATE_LIMITED", 61_200, "This device has reached today's translation limit.")).toBe(
      "This device has reached today's translation limit. It resets in 17 hours.",
    );
    expect(translateErrorMessage("UPSTREAM_RATE_LIMITED", null, "x")).toBe("Claude is busy — try again in a moment.");
  });
});
