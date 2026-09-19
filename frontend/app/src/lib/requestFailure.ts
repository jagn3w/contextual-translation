import { CombinedGraphQLErrors, ServerError } from "@apollo/client";

/**
 * Every way a request can fail *outside* the translate mutation's typed `errors` (design D3.3):
 * top-level GraphQL errors, and plain JSON/HTTP responses from the session endpoint, rack-attack
 * (429) and the Origin/size checks (403/413). Callers switch on `kind` exhaustively.
 */
export type RequestFailure =
  | { kind: "unauthenticated" }
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
