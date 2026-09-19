/**
 * A stand-in for the Rails API behind `fetch`, so tests exercise the real Apollo client and
 * session helpers. Handlers get the parsed JSON body (for /graphql: operationName + variables).
 */
type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

export type FakeServer = {
  onGraphql: (operationName: string, handler: Handler) => void;
  onSession: (method: "POST" | "DELETE", handler: Handler) => void;
  requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export const unauthenticated = () =>
  json({ errors: [{ message: "Not signed in", extensions: { code: "UNAUTHENTICATED" } }] }, 401);

export function installFakeServer(): FakeServer {
  const graphql = new Map<string, Handler>();
  const session = new Map<string, Handler>();
  const requests: FakeServer["requests"] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ url, method, body });

    if (url.endsWith("/graphql")) {
      const handler = graphql.get(String(body["operationName"]));
      if (handler === undefined) throw new Error(`No fake handler for GraphQL ${String(body["operationName"])}`);
      return handler(body);
    }
    if (url.endsWith("/api/session")) {
      const handler = session.get(method);
      if (handler === undefined) throw new Error(`No fake handler for ${method} /api/session`);
      return handler(body);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });

  return {
    onGraphql: (operationName, handler) => graphql.set(operationName, handler),
    onSession: (method, handler) => session.set(method, handler),
    requests,
  };
}

export const viewer = (label = "Side project") =>
  json({
    data: {
      viewer: {
        __typename: "Viewer",
        accessCodeLabel: label,
        accessCodeExpiresAt: null,
        sessionExpiresAt: "2026-09-19T03:00:00Z",
      },
    },
  });
