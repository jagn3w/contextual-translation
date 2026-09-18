import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";
import { installFakeServer, json, unauthenticated, viewer, type FakeServer } from "./test/fakeServer.ts";

let server: FakeServer;

beforeEach(() => {
  server = installFakeServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App session flow", () => {
  it("restores an existing session on load", async () => {
    server.onGraphql("Viewer", () => viewer("Side project"));

    render(<App />);

    expect(await screen.findByText("Side project")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access code")).not.toBeInTheDocument();
  });

  it("asks for an access code when signed out, then enters the app", async () => {
    let signedIn = false;
    server.onGraphql("Viewer", () => (signedIn ? viewer("Panel") : unauthenticated()));
    server.onSession("POST", (body) => {
      if (body["code"] !== "ctx-GOOD") return json({ error: "invalid_code" }, 401);
      signedIn = true;
      return new Response(null, { status: 204 });
    });
    const user = userEvent.setup();

    render(<App />);
    const input = await screen.findByLabelText("Access code");

    await user.type(input, "ctx-BAD");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work");

    await user.clear(input);
    await user.type(input, "  ctx-GOOD ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Panel")).toBeInTheDocument();
    expect(server.requests.find((request) => request.url.endsWith("/api/session"))?.body).toEqual({ code: "ctx-BAD" });
  });

  it("explains throttling on the gate", async () => {
    server.onGraphql("Viewer", unauthenticated);
    server.onSession("POST", () => json({ error: "too_many_failed_attempts", retryAfterSeconds: 600 }, 429));
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText("Access code"), "ctx-X");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many sign-in attempts. Try again in 10 minutes.");
  });

  it("signs out back to the gate", async () => {
    let signedIn = true;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onSession("DELETE", () => {
      signedIn = false;
      return new Response(null, { status: 204 });
    });
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Access code")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /session ended/i })).not.toBeInTheDocument();
  });

  it("offers a retry when the server can't be reached", async () => {
    let attempts = 0;
    server.onGraphql("Viewer", () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return viewer("Back online");
    });
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Back online")).toBeInTheDocument();
  });

  it("stays signed in, and says so, when signing out fails", async () => {
    server.onGraphql("Viewer", () => viewer("Panel"));
    server.onSession("DELETE", () => json({ error: "forbidden_origin" }, 403));
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByText(/Couldn't sign out/)).toBeInTheDocument();
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access code")).not.toBeInTheDocument();
  });
});
