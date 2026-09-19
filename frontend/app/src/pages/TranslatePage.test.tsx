import { render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { App } from "../App.tsx";
import { installFakeServer, json, unauthenticated, viewer, type FakeServer } from "../test/fakeServer.ts";

let server: FakeServer;

function translated(text: string, notes: string | null, sourceLanguage = "EN", targetLanguage = "ES") {
  return json({
    data: {
      translate: {
        __typename: "TranslatePayload",
        translation: { __typename: "Translation", text, notes, sourceLanguage, targetLanguage },
        errors: [],
      },
    },
  });
}

async function renderSignedIn() {
  server.onGraphql("Viewer", () => viewer());
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("Side project");
  return user;
}

beforeEach(() => {
  server = installFakeServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TranslatePage", () => {
  it("translates with context and shows Claude's note", async () => {
    server.onGraphql("Translate", () => translated("¿Esto es un bate?", "Baseball bat; informal tú."));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.type(screen.getByLabelText("Context"), "At a baseball game");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText("¿Esto es un bate?")).toBeInTheDocument();
    expect(within(result).getByText("Baseball bat; informal tú.")).toBeInTheDocument();
    const request = server.requests.find((r) => r.body["operationName"] === "Translate");
    expect(request?.body["variables"]).toEqual({
      input: { sourceText: "Is this a bat?", sourceLanguage: "EN", targetLanguage: "ES", context: "At a baseball game" },
    });
  });

  it("sends a blank context as null and supports Ctrl+Enter", async () => {
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(await screen.findByText("Hola")).toBeInTheDocument();
    const request = server.requests.find((r) => r.body["operationName"] === "Translate");
    expect((request?.body["variables"] as { input: { context: unknown } }).input.context).toBeNull();
  });

  it("disables the button until there is text", async () => {
    await renderSignedIn();

    expect(screen.getByRole("button", { name: "Update Translation" })).toBeDisabled();
  });

  it("swaps languages and moves the translation into the source pane", async () => {
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Hola");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(screen.getByLabelText("Text to translate")).toHaveValue("Hola");
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Spanish");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("English");
  });

  it("picking the other pane's language swaps them instead of allowing a same-language pair", async () => {
    const user = await renderSignedIn();

    // Keyboard-driven (jsdom can't fire the pointer events Radix listens for on click).
    screen.getByRole("combobox", { name: "Target language" }).focus();
    await user.keyboard("{ArrowDown}");
    const english = await screen.findByRole("option", { name: /English/ });
    english.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Spanish");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("English");
  });

  it("returns to the gate with a notice when the session ends mid-use", async () => {
    let signedIn = true;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onGraphql("Translate", () => {
      signedIn = false;
      return unauthenticated();
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Side project");

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByLabelText("Access code")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your session ended");
  });

  it("shows a typed error as a toast without a retry when retrying won't help", async () => {
    server.onGraphql("Translate", () =>
      json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [{ __typename: "TranslateError", code: "REFUSED", message: "x", retryable: false, retryAfterSeconds: null }],
          },
        },
      }),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByText("Claude declined to translate this text.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry for retryable errors, and the retry can succeed", async () => {
    let calls = 0;
    server.onGraphql("Translate", () => {
      calls += 1;
      if (calls > 1) return translated("Hola", null);
      return json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [
              { __typename: "TranslateError", code: "UPSTREAM_OVERLOADED", message: "x", retryable: true, retryAfterSeconds: null },
            ],
          },
        },
      });
    });
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await screen.findByText("Claude is temporarily overloaded. Try again shortly.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Hola")).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("shows our per-minute rate limit with the wait, and no retry that would be refused", async () => {
    server.onGraphql("Translate", () =>
      json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [
              {
                __typename: "TranslateError",
                code: "RATE_LIMITED",
                message: "You're translating quickly.",
                retryable: true,
                retryAfterSeconds: 30,
              },
            ],
          },
        },
      }),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByText("You're translating quickly. Try again in 30 seconds.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("a daily cap says when it resets and offers no retry", async () => {
    server.onGraphql("Translate", () =>
      json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [
              {
                __typename: "TranslateError",
                code: "RATE_LIMITED",
                message: "This device has reached today's translation limit.",
                retryable: true,
                retryAfterSeconds: 61_200,
              },
            ],
          },
        },
      }),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(
      await screen.findByText("This device has reached today's translation limit. It resets in 17 hours."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows non-GraphQL failures (rack-attack 429, INTERNAL) as toasts", async () => {
    let calls = 0;
    server.onGraphql("Translate", () => {
      calls += 1;
      if (calls === 1) return json({ error: "rate_limited", retryAfterSeconds: 20 }, 429);
      return json({
        data: null,
        errors: [{ message: "Something unexpected went wrong.", extensions: { code: "INTERNAL", reference: "ab12cd34" } }],
      });
    });
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");

    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await screen.findByText("Too many requests. Try again in 20 seconds.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await screen.findByText("Something unexpected went wrong (reference ab12cd34).")).toBeInTheDocument();
  });

  it("shows a loading state while translating", async () => {
    let respond: (response: Response) => void = () => undefined;
    server.onGraphql("Translate", () => new Promise<Response>((resolve) => (respond = resolve)));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByRole("button", { name: "Translating…" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Translation result" })).toHaveAttribute("aria-busy", "true");
    respond(translated("Hola", null));
    expect(await screen.findByText("Hola")).toBeInTheDocument();
  });

  it("Try again sends the current inputs, not the ones from when the error happened", async () => {
    let calls = 0;
    server.onGraphql("Translate", () => {
      calls += 1;
      if (calls > 1) return translated("Adiós", null);
      return json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [{ __typename: "TranslateError", code: "UPSTREAM_ERROR", message: "x", retryable: true, retryAfterSeconds: null }],
          },
        },
      });
    });
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");

    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Claude had a problem. Try again.");
    await user.clear(source);
    await user.type(source, "Goodbye");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Adiós")).toBeInTheDocument();
    const last = server.requests.filter((r) => r.body["operationName"] === "Translate").at(-1);
    expect((last?.body["variables"] as { input: { sourceText: string } }).input.sourceText).toBe("Goodbye");
  });

  it("swap labels a stale translation by the languages it was made in", async () => {
    server.onGraphql("Translate", () => translated("Hola", null, "EN", "ES"));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Hola");

    screen.getByRole("combobox", { name: "Target language" }).focus();
    await user.keyboard("{ArrowDown}");
    const japanese = await screen.findByRole("option", { name: /Japanese/ });
    japanese.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(screen.getByLabelText("Text to translate")).toHaveValue("Hola");
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Spanish");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("English");
  });

  it("blocks text over the limit with a visible reason instead of truncating it", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");

    await user.click(source);
    await user.paste("a".repeat(10_001));

    expect(source).toHaveValue("a".repeat(10_001));
    expect(screen.getByText(/Too long to translate/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Translation" })).toBeDisabled();
  });

  it("dismisses a pending error toast when signing out", async () => {
    let signedIn = true;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onSession("DELETE", () => {
      signedIn = false;
      return new Response(null, { status: 204 });
    });
    server.onGraphql("Translate", () =>
      json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [{ __typename: "TranslateError", code: "TIMEOUT", message: "x", retryable: true, retryAfterSeconds: null }],
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Side project");
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText(/took too long/);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await screen.findByLabelText("Access code");
    await waitFor(() => expect(screen.queryByText(/took too long/)).not.toBeInTheDocument());
  });

  it("swap keeps text typed after translating, and the old result is marked out of date", async () => {
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Hola");

    await user.clear(source);
    await user.type(source, "A new paragraph I haven't translated");
    expect(screen.getByRole("region", { name: "Translation result" })).toHaveClass("opacity-60");
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("A new paragraph I haven't translated");
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Spanish");
  });

  it("editing the context marks the result out of date", async () => {
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Hola");
    const result = screen.getByRole("region", { name: "Translation result" });
    expect(result).not.toHaveClass("opacity-60");

    await user.type(screen.getByLabelText("Context"), "At a baseball game");

    expect(result).toHaveClass("opacity-60");
  });

  it("announces the result through an always-mounted live region", async () => {
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = await renderSignedIn();
    const status = screen.getByRole("status");

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("Hola");

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Translation ready.");
  });

  it("drops a response that arrives after signing out", async () => {
    let signedIn = true;
    let respond: (response: Response) => void = () => undefined;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onSession("DELETE", () => {
      signedIn = false;
      return new Response(null, { status: 204 });
    });
    server.onGraphql("Translate", () => new Promise<Response>((resolve) => (respond = resolve)));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Side project");
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Access code");
    respond(
      json({
        data: {
          translate: {
            __typename: "TranslatePayload",
            translation: null,
            errors: [{ __typename: "TranslateError", code: "TIMEOUT", message: "x", retryable: true, retryAfterSeconds: null }],
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/took too long/)).not.toBeInTheDocument();
  });

  it("counts length in code points, like the backend", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");

    await user.click(source);
    await user.paste("😀".repeat(10_000)); // 20,000 UTF-16 units, 10,000 code points

    expect(screen.getByText("10,000 / 10,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Translation" })).toBeEnabled();
  });

  it("translates under StrictMode (dev mounts, unmounts and remounts every component)", async () => {
    server.onGraphql("Viewer", () => viewer());
    server.onGraphql("Translate", () => translated("Hola", null));
    const user = userEvent.setup();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByText("Side project");

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByText("Hola")).toBeInTheDocument();
  });
});
