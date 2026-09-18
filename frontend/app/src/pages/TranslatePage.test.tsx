import { render, screen, within } from "@testing-library/react";
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
});
