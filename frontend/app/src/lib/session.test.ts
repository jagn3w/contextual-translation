import { signIn, signOut } from "./session.ts";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signIn", () => {
  it("posts the code as JSON and succeeds on 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(signIn("ctx-ABCD")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ code: "ctx-ABCD" }),
    }));
  });

  it("reports a wrong code", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_code" }), { status: 401 }));

    await expect(signIn("nope")).resolves.toEqual({ ok: false, reason: "invalidCode" });
  });

  it("reports throttling with the retry delay", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "too_many_failed_attempts", retryAfterSeconds: 600 }), { status: 429 }),
    );

    await expect(signIn("nope")).resolves.toEqual({
      ok: false,
      reason: { kind: "rateLimited", retryAfterSeconds: 600 },
    });
  });

  it("reports network failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(signIn("x")).resolves.toEqual({ ok: false, reason: { kind: "network" } });
  });
});

describe("signOut", () => {
  it("succeeds only when the server confirms", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(signOut()).resolves.toEqual({ ok: true });
  });

  it("reports network failures and rejected requests instead of pretending", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(signOut()).resolves.toEqual({ ok: false, reason: { kind: "network" } });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden_origin" }), { status: 403 }));
    await expect(signOut()).resolves.toEqual({ ok: false, reason: { kind: "blocked" } });
  });
});
