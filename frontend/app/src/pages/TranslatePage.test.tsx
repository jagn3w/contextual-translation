import { render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { App } from "../App.tsx";
import { installFakeServer, json, unauthenticated, viewer, type FakeServer } from "../test/fakeServer.ts";

let server: FakeServer;

/** One glossed word of a fake response; `length` is counted in code points, as the backend does. */
function gloss(text: string, startsAt: number, meaning: string, reading: string | null = null) {
  return { __typename: "Gloss", text, reading, meaning, startsAt, length: [...text].length };
}

/**
 * The fake server answers with exactly this JSON, so every field the query asks for has to be
 * here — `furigana` included, defaulting to the null a non-Japanese (or un-annotated) answer has,
 * and `glosses`, which is never null and empty when nothing is glossed.
 */
function translated(
  text: string,
  notes: string | null,
  sourceLanguage = "EN",
  targetLanguage = "JA",
  furigana: string | null = null,
  glosses: ReturnType<typeof gloss>[] = [],
  glossesTruncated = false,
) {
  return json({
    data: {
      translate: {
        __typename: "TranslatePayload",
        translation: {
          __typename: "Translation",
          text,
          notes,
          furigana,
          glosses,
          glossesTruncated,
          sourceLanguage,
          targetLanguage,
        },
        errors: [],
      },
    },
  });
}

/** The readings on screen, in order: one per `<ruby>` in the result pane. */
function readings(pane: HTMLElement): string[] {
  return [...pane.querySelectorAll("rt")].map((rt) => rt.textContent ?? "");
}

/**
 * The pane's text with the readings taken out — the translation underneath the ruby. This is *not*
 * a model of a copy: a browser folds `<rt>` text into a plain-text copy, which is the whole reason
 * the readings carry `select-none` (asserted on the elements themselves, where a browser reads it).
 */
function textWithoutReadings(pane: HTMLElement): string {
  const copy = pane.cloneNode(true) as HTMLElement;
  for (const rt of copy.querySelectorAll("rt")) rt.remove();
  return copy.textContent ?? "";
}

/**
 * How the pane says its contents are out of date: a dimmed ground and a named marker. Never by
 * dimming the ink — a blanket opacity over the frame put the translation under WCAG AA — so these
 * also assert that the old `opacity-60` has not come back.
 */
function expectOutOfDate(result: HTMLElement) {
  expect(result).toHaveClass("bg-frame-stale");
  expect(result).not.toHaveClass("opacity-60");
  expect(within(result).getByText("Out of date")).toBeInTheDocument();
}

function expectUpToDate(result: HTMLElement) {
  expect(result).toHaveClass("bg-frame");
  expect(result).not.toHaveClass("opacity-60");
  expect(within(result).queryByText("Out of date")).not.toBeInTheDocument();
}

/** Picks a language from one of the two pickers (Radix Select; jsdom can't fire its pointer events). */
async function pickLanguage(user: ReturnType<typeof userEvent.setup>, picker: string, name: RegExp) {
  screen.getByRole("combobox", { name: picker }).focus();
  await user.keyboard("{ArrowDown}");
  const option = await screen.findByRole("option", { name });
  option.focus();
  await user.keyboard("{Enter}");
}

/** Picks a gloss level the same way — the picker is the same Radix Select, in the source footer. */
async function pickGlossLevel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  screen.getByRole("combobox", { name: "Definitions" }).focus();
  await user.keyboard("{ArrowDown}");
  const option = await screen.findByRole("option", { name });
  option.focus();
  await user.keyboard("{Enter}");
}

async function renderSignedIn() {
  server.onGraphql("Viewer", () => viewer());
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Sign out" });
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
    server.onGraphql("Translate", () => translated("これはバットですか？", "Baseball bat; plain form."));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.type(screen.getByLabelText("Context"), "At a baseball game");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText("これはバットですか？")).toBeInTheDocument();
    expect(within(result).getByText("Baseball bat; plain form.")).toBeInTheDocument();
    const request = server.requests.find((r) => r.body["operationName"] === "Translate");
    expect(request?.body["variables"]).toEqual({
      input: {
        sourceText: "Is this a bat?",
        sourceLanguage: "EN",
        targetLanguage: "JA",
        context: "At a baseball game",
        // The default level travels with every request rather than being left to the schema default.
        glossLevel: "NOTABLE",
      },
    });
  });

  it("sends a blank context as null and supports Ctrl+Enter", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
    const request = server.requests.find((r) => r.body["operationName"] === "Translate");
    expect((request?.body["variables"] as { input: { context: unknown } }).input.context).toBeNull();
  });

  it("puts Claude's readings over the kanji of a Japanese translation", async () => {
    server.onGraphql("Translate", () =>
      translated("今日は良い天気ですね", null, "EN", "JA", "今日《きょう》は良《よ》い天気《てんき》ですね"),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Nice weather today");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(3));
    expect(readings(result)).toEqual(["きょう", "よ", "てんき"]);
    // The translation itself is still the pane's text: the 《…》 markup never reaches the DOM.
    expect(textWithoutReadings(result)).toBe("今日は良い天気ですね");
    expect(result.textContent).not.toContain("《");
    // A plain-text copy would otherwise carry the readings with it — 今日きょうは良よい天気てんき
    // ですね — straight into whatever the user is writing. select-none is what stops that.
    const annotations = [...result.querySelectorAll<HTMLElement>("rt")];
    expect(annotations).toHaveLength(3);
    for (const rt of annotations) expect(rt).toHaveClass("select-none");
  });

  it("renders plain text when there are no readings to show", async () => {
    server.onGraphql("Translate", () => translated("Hola", null, "EN", "ES"));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText("Hola")).toBeInTheDocument();
    expect(result.querySelectorAll("ruby")).toHaveLength(0);
  });

  it("says so when the definitions ran out before the translation did", async () => {
    server.onGraphql("Translate", () => translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")], true));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText(/Definitions stop partway/)).toBeInTheDocument();
  });

  it("says nothing about definitions when none were dropped", async () => {
    server.onGraphql("Translate", () => translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByRole("button", { name: "バット" })).toBeInTheDocument();
    expect(within(result).queryByText(/Definitions stop partway/)).not.toBeInTheDocument();
  });

  it("drops the readings after a swap, where the pane holds the text Claude translated from", async () => {
    server.onGraphql("Translate", () => translated("日本語", null, "EN", "JA", "日本語《にほんご》"));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Japanese");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    // The pane now shows the English that was translated *from*; there is nothing to annotate.
    expect(within(result).getByText("Japanese")).toBeInTheDocument();
    expect(result.querySelectorAll("ruby")).toHaveLength(0);
  });

  it("does not put the access code on screen", async () => {
    await renderSignedIn();

    // The header carries the sign-out control alone; the code's label is nobody's business here.
    expect(screen.queryByText("Side project")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("leaves a pane's height to CSS where nothing is laid out", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");

    await user.type(source, "Hello");

    // jsdom answers scrollHeight 0, so the auto-grow hook must hand the height back to the
    // frame's min-height instead of collapsing it to 0px.
    expect(source.style.height).toBe("");
  });

  it("disables the button until there is text", async () => {
    await renderSignedIn();

    expect(screen.getByRole("button", { name: "Update Translation" })).toBeDisabled();
  });

  it("swaps languages, putting the translation in the source pane and the original in the result", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(source).toHaveValue("こんにちは");
    expect(within(result).getByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Japanese");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("English");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("Hello");
    expect(within(result).getByText("こんにちは")).toBeInTheDocument();
  });

  it("swapping twice returns to an identical state, after translating", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", "Plain form."));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(source).toHaveValue("Hello");
    expect(within(result).getByText("こんにちは")).toBeInTheDocument();
    expect(within(result).getByText("Plain form.")).toBeInTheDocument();
    expectUpToDate(result);
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("English");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("Japanese");
  });

  it("swapping twice returns to an identical state, with an untranslated draft", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "A draft nobody has translated");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("A draft nobody has translated");
    expect(screen.getByText("Translation")).toBeInTheDocument(); // the empty result pane
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("English");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveTextContent("Japanese");
  });

  it("a draft sticks with the language it was typed in", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "An English draft");

    await pickLanguage(user, "Source language", /Spanish/);
    expect(source).toHaveValue("");
    await user.type(source, "Un borrador");
    await pickLanguage(user, "Source language", /English/);

    expect(source).toHaveValue("An English draft");

    await pickLanguage(user, "Source language", /Spanish/);

    expect(source).toHaveValue("Un borrador");
  });

  it("a new translation throws out the dirty buffers on both sides of the pair", async () => {
    let calls = 0;
    server.onGraphql("Translate", () => {
      calls += 1;
      return calls === 1 ? translated("こんにちは", null) : translated("Goodbye", null, "JA", "EN");
    });
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));
    await user.clear(source);
    await user.click(source);
    await user.paste("さようなら");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await screen.findByText("Goodbye")).toBeInTheDocument();

    // Both languages the response involved are clean again: English's "Hello" draft is gone.
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(source).toHaveValue("Goodbye");
    expect(within(result).getByText("さようなら")).toBeInTheDocument();
    expectUpToDate(result);
  });

  it("puts each picker's label on an element that can actually truncate", async () => {
    await renderSignedIn();

    // Radix's Select.Value destructures `className` away and never applies it, so a truncation
    // class written there is invisible to the browser. Assert it where the browser would read it.
    for (const picker of ["Source language", "Target language", "Definitions"]) {
      const label = screen.getByRole("combobox", { name: picker }).querySelector<HTMLElement>(".truncate");
      expect(label).not.toBeNull();
      expect(label?.textContent ?? "").not.toBe("");
    }
  });

  it("picking the other pane's language swaps them instead of allowing a same-language pair", async () => {
    const user = await renderSignedIn();

    await pickLanguage(user, "Target language", /English/);

    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Japanese");
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
    await screen.findByRole("button", { name: "Sign out" });

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
      if (calls > 1) return translated("こんにちは", null);
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

    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
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
    respond(translated("こんにちは", null));
    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
  });

  it("Try again sends the current inputs, not the ones from when the error happened", async () => {
    let calls = 0;
    server.onGraphql("Translate", () => {
      calls += 1;
      if (calls > 1) return translated("さようなら", null);
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

    expect(await screen.findByText("さようなら")).toBeInTheDocument();
    const last = server.requests.filter((r) => r.body["operationName"] === "Translate").at(-1);
    expect((last?.body["variables"] as { input: { sourceText: string } }).input.sourceText).toBe("Goodbye");
  });

  it("a translation stays with the language it is in when the target picker changes", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    // Spanish has never been translated, so its pane is empty…
    await pickLanguage(user, "Target language", /Spanish/);
    expect(screen.getByText("Translation")).toBeInTheDocument();

    // …and the Japanese text is still waiting, up to date, when Japanese comes back.
    await pickLanguage(user, "Target language", /Japanese/);

    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expectUpToDate(screen.getByRole("region", { name: "Translation result" }));
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
    await screen.findByRole("button", { name: "Sign out" });
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText(/took too long/);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await screen.findByLabelText("Access code");
    await waitFor(() => expect(screen.queryByText(/took too long/)).not.toBeInTheDocument());
  });

  it("swap keeps text typed after translating, and the old result is marked out of date", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    await user.clear(source);
    await user.type(source, "A new paragraph I haven't translated");
    expectOutOfDate(screen.getByRole("region", { name: "Translation result" }));

    // The draft stays with English: swapping shows Japanese's text, swapping back brings it back.
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("こんにちは");
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveTextContent("Japanese");

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("A new paragraph I haven't translated");
    expectOutOfDate(screen.getByRole("region", { name: "Translation result" }));
  });

  it("keeps a draft typed while the request was in flight", async () => {
    let respond: (response: Response) => void = () => undefined;
    server.onGraphql("Translate", () => new Promise<Response>((resolve) => (respond = resolve)));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    // The box stays editable for the 5-20s Claude takes, and people use that time. Writing the
    // text that was *sent* back over the box would destroy that work, with no undo to recover it.
    await user.type(source, " I mean the animal.");
    respond(translated("これはバットですか？", null));

    expect(await screen.findByText("これはバットですか？")).toBeInTheDocument();
    expect(source).toHaveValue("Is this a bat? I mean the animal.");
    // The translation is real but answers the older text, so the pane says so rather than
    // pretending the pair on screen is what Claude was asked about.
    expectOutOfDate(screen.getByRole("region", { name: "Translation result" }));
  });

  it("resets an untouched source box when the response lands, so a swap is clean", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

    const result = screen.getByRole("region", { name: "Translation result" });
    expectUpToDate(result);
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(source).toHaveValue("こんにちは");
    expect(within(result).getByText("Hello")).toBeInTheDocument();
  });

  it("keeps the readings and the note when only the source picker moves", async () => {
    server.onGraphql("Translate", () =>
      translated("今日は良い天気ですね", "Plain form.", "EN", "JA", "今日《きょう》は良《よ》い天気《てんき》ですね"),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Nice weather today");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(3));

    await pickLanguage(user, "Source language", /Spanish/);

    // The Japanese in the pane is untouched, so what Claude said about it is still true of it.
    expect(readings(result)).toEqual(["きょう", "よ", "てんき"]);
    expect(within(result).getByText("Plain form.")).toBeInTheDocument();
    // That the pickers have moved on is what the out-of-date marker is for.
    expectOutOfDate(result);
  });

  it("editing the context marks the result out of date", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");
    const result = screen.getByRole("region", { name: "Translation result" });
    expectUpToDate(result);

    await user.type(screen.getByLabelText("Context"), "At a baseball game");

    expectOutOfDate(result);
  });

  it("announces the result through an always-mounted live region", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    const status = screen.getByRole("status");

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");

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
    await screen.findByRole("button", { name: "Sign out" });
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

  it("makes a glossed word hoverable, leaving the rest of the translation plain text", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByRole("button", { name: "バット" })).toBeInTheDocument();
    // Only the glossed word is a control; the sentence around it is still ordinary text, and the
    // pane still reads (and copies) as the translation.
    expect(within(result).getAllByRole("button")).toHaveLength(1);
    expect(result.textContent).toBe("これはバットですか？");
  });

  it("shows a definition on keyboard focus", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const word = await screen.findByRole("button", { name: "バット" });

    // Focus rather than a simulated hover: jsdom has no pointer, and this is the keyboard path.
    word.focus();

    // The tooltip, specifically: role="tooltip" is what a screen reader follows from the trigger.
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Baseball bat.")).toBeInTheDocument();
    expect(within(tooltip).getByText("バット")).toBeInTheDocument();
  });

  it("shows a definition on a tap, which is what touch gets instead of a hover", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const word = await screen.findByRole("button", { name: "バット" });

    await user.click(word);

    // The popover (role="dialog"), which is what touch gets: Radix's tooltip never fires on a tap.
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText("Baseball bat.")).toBeInTheDocument();
    // One card, not two: the tooltip gives way to the popover the tap opened, rather than
    // lingering behind it. The tooltip's own hover delay has to elapse before this can be trusted.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getAllByText("Baseball bat.")).toHaveLength(1);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps the reading inside a glossed word", async () => {
    server.onGraphql("Translate", () =>
      translated("今日は良い天気ですね", null, "EN", "JA", "今日《きょう》は良《よ》い天気《てんき》ですね", [
        gloss("天気", 5, "The weather.", "てんき"),
      ]),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Nice weather today");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    // The button's accessible name picks up the reading too, so match on the word itself.
    const word = await within(result).findByRole("button", { name: /天気/ });
    expect(readings(word)).toEqual(["てんき"]);
    // The other two readings are still there, outside the glossed word, and the text is unchanged.
    expect(readings(result)).toEqual(["きょう", "よ", "てんき"]);
    expect(textWithoutReadings(result)).toBe("今日は良い天気ですね");
  });

  it("sends the chosen gloss level with the next translation", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");

    await pickGlossLevel(user, /^All$/);
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
    const last = server.requests.filter((r) => r.body["operationName"] === "Translate").at(-1);
    expect((last?.body["variables"] as { input: { glossLevel: string } }).input.glossLevel).toBe("EVERY");
  });

  it("changing the gloss level marks the result out of date", async () => {
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    await screen.findByText("こんにちは");
    const result = screen.getByRole("region", { name: "Translation result" });
    expectUpToDate(result);

    // Claude chooses the words and writes the definitions, so a new level needs a new answer.
    await pickGlossLevel(user, /^All$/);

    expectOutOfDate(result);
  });

  it("translates under StrictMode (dev mounts, unmounts and remounts every component)", async () => {
    server.onGraphql("Viewer", () => viewer());
    server.onGraphql("Translate", () => translated("こんにちは", null));
    const user = userEvent.setup();
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole("button", { name: "Sign out" });

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    expect(await screen.findByText("こんにちは")).toBeInTheDocument();
  });
});
