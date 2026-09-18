import { formatWait } from "./formatWait.ts";

describe("formatWait", () => {
  it.each([
    [1, "in 1 second"],
    [45, "in 45 seconds"],
    [60, "in 1 minute"],
    [600, "in 10 minutes"],
    [3600, "in 1 hour"],
    [7201, "in 3 hours"],
  ])("formats %i seconds", (seconds, expected) => {
    expect(formatWait(seconds)).toBe(expected);
  });
});
