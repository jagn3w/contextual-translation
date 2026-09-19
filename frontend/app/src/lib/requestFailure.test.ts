import { CombinedGraphQLErrors, ServerError } from "@apollo/client";
import { describeRequestError, failureFromResponse } from "./requestFailure.ts";

function serverError(status: number, body: unknown, headers: Record<string, string> = {}) {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const response = new Response(bodyText, { status, headers });
  return new ServerError("Response not successful", { response, bodyText });
}

describe("describeRequestError", () => {
  it("treats a 401 from /graphql as unauthenticated", () => {
    const error = serverError(401, { errors: [{ message: "Not signed in", extensions: { code: "UNAUTHENTICATED" } }] });

    expect(describeRequestError(error)).toEqual({ kind: "unauthenticated" });
  });

  it("reads rack-attack's 429 body for the retry delay", () => {
    expect(describeRequestError(serverError(429, { error: "rate_limited", retryAfterSeconds: 42 }))).toEqual({
      kind: "rateLimited",
      retryAfterSeconds: 42,
    });
  });

  it("falls back to the retry-after header", () => {
    expect(describeRequestError(serverError(429, "slow down", { "retry-after": "9" }))).toEqual({
      kind: "rateLimited",
      retryAfterSeconds: 9,
    });
  });

  it("maps the Origin check and body-size limit", () => {
    expect(describeRequestError(serverError(403, { error: "forbidden_origin" }))).toEqual({ kind: "blocked" });
    expect(describeRequestError(serverError(415, { error: "unsupported_media_type" }))).toEqual({ kind: "blocked" });
    expect(describeRequestError(serverError(413, { error: "payload_too_large" }))).toEqual({ kind: "payloadTooLarge" });
    expect(describeRequestError(serverError(502, "<html>Bad gateway</html>"))).toEqual({ kind: "server", status: 502 });
  });

  it("maps top-level GraphQL errors, keeping the INTERNAL log reference", () => {
    const internal = new CombinedGraphQLErrors({
      errors: [{ message: "Something unexpected went wrong.", extensions: { code: "INTERNAL", reference: "ab12cd34" } }],
    });
    const unauthenticated = new CombinedGraphQLErrors({
      errors: [{ message: "Not signed in", extensions: { code: "UNAUTHENTICATED" } }],
    });

    expect(describeRequestError(internal)).toEqual({ kind: "internal", reference: "ab12cd34" });
    expect(describeRequestError(unauthenticated)).toEqual({ kind: "unauthenticated" });
  });

  it("treats anything else as a network failure", () => {
    expect(describeRequestError(new TypeError("Failed to fetch"))).toEqual({ kind: "network" });
  });
});

describe("failureFromResponse", () => {
  it("ignores unparseable bodies", () => {
    expect(failureFromResponse(429, "<html>", null)).toEqual({ kind: "rateLimited", retryAfterSeconds: null });
  });
});
