import { CombinedGraphQLErrors, ServerError } from "@apollo/client";

/**
 * Every way a request can fail *outside* a mutation's typed `errors`: top-level GraphQL errors,
 * and plain JSON/HTTP responses from the session endpoint, rack-attack (429) and the Origin,
 * content-type and size checks (403/415/411/413). Callers switch on `kind` exhaustively.
 */
export type RequestFailure =
  | { kind: "unauthenticated" }
  /** `NOT_FOUND`: the id names nothing this session can see (missing, malformed, deleted). */
  | { kind: "notFound" }
  /**
   * `INVALID`: a change the server refuses on purpose. There is more than one reason (a diary
   * entry's languages after feedback, or languages changed while Claude was answering), so the
   * server's own sentence travels with it; null when the error carried none.
   */
  | { kind: "invalid"; message: string | null }
  | { kind: "rateLimited"; retryAfterSeconds: number | null }
  | { kind: "blocked" }
  | { kind: "payloadTooLarge" }
  | { kind: "internal"; reference: string | null }
  | { kind: "network" }
  | { kind: "server"; status: number };

type JsonErrorBody = { error?: unknown; retryAfterSeconds?: unknown };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function retryAfterFrom(body: JsonErrorBody | null, header: string | null): number | null {
  if (typeof body?.retryAfterSeconds === "number") return body.retryAfterSeconds;
  const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Classifies an HTTP status plus its (possibly JSON) body. */
export function failureFromResponse(status: number, bodyText: string, retryAfterHeader: string | null): RequestFailure {
  const body = parseJson(bodyText) as JsonErrorBody | null;
  switch (status) {
    case 401:
      return { kind: "unauthenticated" };
    case 403: // the Origin check
    case 411: // a chunked body with no Content-Length (never sent by fetch)
    case 415: // not sent as JSON
      return { kind: "blocked" };
    case 413:
      return { kind: "payloadTooLarge" };
    case 429:
      return { kind: "rateLimited", retryAfterSeconds: retryAfterFrom(body, retryAfterHeader) };
    default:
      return { kind: "server", status };
  }
}

/** Classifies an error thrown by Apollo Client (or fetch) for an operation. */
export function describeRequestError(error: unknown): RequestFailure {
  if (CombinedGraphQLErrors.is(error)) {
    const codes = error.errors.map((graphQLError) => graphQLError.extensions?.["code"]);
    if (codes.includes("UNAUTHENTICATED")) return { kind: "unauthenticated" };
    if (codes.includes("NOT_FOUND")) return { kind: "notFound" };
    if (codes.includes("INVALID")) {
      const message = error.errors.find((graphQLError) => graphQLError.extensions?.["code"] === "INVALID")?.message;
      return { kind: "invalid", message: message === undefined || message === "" ? null : message };
    }
    // INTERNAL, and validation errors, which carry no code: nothing the user did wrong. The SPA's
    // own operations can't fail validation, so reaching one means client and server disagree.
    const reference = error.errors
      .map((graphQLError) => graphQLError.extensions?.["reference"])
      .find((value): value is string => typeof value === "string");
    return { kind: "internal", reference: reference ?? null };
  }
  if (ServerError.is(error)) {
    return failureFromResponse(error.statusCode, error.bodyText, error.response.headers.get("retry-after"));
  }
  return { kind: "network" };
}

export function isUnauthenticated(error: unknown): boolean {
  return describeRequestError(error).kind === "unauthenticated";
}
