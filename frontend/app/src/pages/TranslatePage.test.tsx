import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  readingsOmitted = false,
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
          readingsOmitted,
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
 * What a screen reader has to read out of an element: its text with the `aria-hidden` subtrees
 * gone, which is the rule the accessible name computation and every AT follow. jsdom has no screen
 * reader, so this models one thing about them — and it is the thing this pane got wrong, `<rt>`
 * being exposed as static text in Chrome and Firefox. It is *not* `textWithoutReadings` by another
 * name: that one takes the readings out by tag, this one by what is hidden, and they agree only
 * because the readings are hidden. Untie them and this returns 今日きょうは良よい天気てんきですね.
 */
function announcedText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) hidden.remove();
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

  it("keeps the readings out of what a screen reader reads, in the paragraph and in a glossed word", async () => {
    server.onGraphql("Translate", () =>
      translated("今日は良い天気ですね", null, "EN", "JA", "今日《きょう》は良《よ》い天気《てんき》ですね", [
        gloss("天気", 5, "The weather.", "てんき"),
      ]),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Nice weather today");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(3));

    // Chrome and Firefox expose <rt> as static text, so the sentence NVDA and VoiceOver read was
    // 今日きょうは良よい天気てんきですね — every reading run into the word it sits over. The pane
    // exists to be read; hiding the readings from the accessibility tree is what makes it readable.
    const paragraph = result.querySelector("ruby")?.closest("p");
    expect(paragraph).not.toBeNull();
    expect(announcedText(paragraph as HTMLElement)).toBe("今日は良い天気ですね");
    const annotations = [...result.querySelectorAll("rt")];
    expect(annotations).toHaveLength(3);
    for (const rt of annotations) expect(rt).toHaveAttribute("aria-hidden", "true");

    // The same rule put through the real name algorithm, on the one element in the pane that has
    // an accessible name. It is the name from the button's *contents* — the aria-label that used
    // to fix this one word by hand is gone, so there is no second mechanism to drift out of step
    // with the one above, and a glossed word is announced exactly like the plain word beside it.
    const word = within(result).getByRole("button", { name: "天気" });
    expect(word).toHaveAccessibleName("天気");
    expect(word).not.toHaveAttribute("aria-label");
  });

  it("renders plain text when there are no readings to show", async () => {
    server.onGraphql("Translate", () => translated("Hola", null, "EN", "ES"));
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText("Hola")).toBeInTheDocument();
    expect(result.querySelectorAll("ruby")).toHaveLength(0);
    // Spanish was never going to have readings, so there is nothing missing to report. The flag
    // is false for every target but Japanese, and the pane stays quiet about it.
    expect(within(result).queryByText(/kana readings/)).not.toBeInTheDocument();
  });

  it("says so when the definitions ran out before the translation did", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("これ", 0, "This."), gloss("バット", 3, "Baseball bat.")], true),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    // How many definitions arrived, counted from the response in hand. What ran out is a cap on
    // entries, so the message may not blame the size of the answer or of the translation — and
    // the count may not be a copy of the backend's constant, free to drift from what came back.
    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText(/2 words are defined and the rest of the translation is not/)).toBeInTheDocument();
  });

  it("says this answer has no readings, without naming a cause it can't know", async () => {
    // Whatever dropped the furigana — the length gate never asking, or what came back being
    // rejected — the definitions arrive regardless, so the pane goes on implying an annotated
    // answer while the readings quietly aren't there. `furigana` is null either way, and the flag
    // is the only thing that separates "you didn't get these" from "this Japanese has no kanji".
    // The flag does not say which cause it was, so neither may the sentence.
    // The gloss carries a reading, which is the case the notice may not talk over: `gloss_from`
    // keeps `reading` for any Japanese target whatever dropped the furigana, so this pane both
    // prints "no readings" and hands one over on hover.
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.", "ばっと")], false, true),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    const result = screen.getByRole("region", { name: "Translation result" });
    // What was given up is the ruby over the translation, and the sentence says that much and
    // stops. "so this translation has none" was a claim about the whole answer, and the reader
    // disproved it by hovering the first defined word.
    expect(
      await within(result).findByText(
        "No kana readings came with this answer, so there are none over the translation. It isn't that the Japanese has no kanji to read.",
      ),
    ).toBeInTheDocument();
    expect(within(result).queryByText(/this translation has none/)).not.toBeInTheDocument();
    // And no cause: the flag is raised both when the readings were never asked for and when what
    // came back was rejected, and the pane is told which by neither the schema nor the payload.
    expect(within(result).queryByText(/too long/)).not.toBeInTheDocument();
    expect(result.querySelectorAll("ruby")).toHaveLength(0);
    // The definitions survived the length switch, and say nothing about having been cut short.
    const word = within(result).getByRole("button", { name: "バット" });
    expect(within(result).queryByText(/Definitions stop partway/)).not.toBeInTheDocument();

    // And the per-word reading survived with them — in the same pane, under the same notice.
    word.focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("ばっと")).toBeInTheDocument();
  });

  it("drops the shortfall notice once the pane stops showing that response", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")], false, true),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText(/kana readings/)).toBeInTheDocument();

    // After a swap the pane holds the English it was asked about, which has no readings to have
    // been dropped. What the response said about *its* output can only be said while that output
    // is what's on screen, which is the same rule the notes and the glosses ride on.
    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    expect(within(result).getByText("Is this a bat?")).toBeInTheDocument();
    expect(within(result).queryByText(/kana readings/)).not.toBeInTheDocument();
  });

  it("runs both shortfalls into one notice rather than stacking two", async () => {
    // A Japanese answer with no readings and more than the cap's worth of glossable words reaches
    // exactly this state. The two are unrelated — a per-answer cap on entries is what ran out for
    // the definitions — so the sentences stay distinct, but they are one block under the
    // translation.
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("これ", 0, "This."), gloss("バット", 3, "Bat.")], true, true),
    );
    const user = await renderSignedIn();

    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    // One element holding both sentences: a regex spanning them can only match if they were
    // rendered together, and the count is what says the pane didn't stack two notices instead.
    const result = screen.getByRole("region", { name: "Translation result" });
    expect(
      await within(result).findByText(
        /^No kana readings came with this answer, so there are none over the translation\. It isn't that the Japanese has no kanji to read\. Definitions stop partway: 2 words are defined and the rest of the translation is not\.$/,
      ),
    ).toBeInTheDocument();
    expect(within(result).getAllByText(/kana readings|Definitions stop partway/)).toHaveLength(1);
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

  it("gives the readings, glosses and note back when a swap → translate → swap leaves the text alone", async () => {
    // The round trip the reader actually performs: read the Japanese, swap to check it back into
    // English, then swap home. Nothing edits the Japanese anywhere in it — the second translation
    // is *out of* that text, not over it — so everything Claude said about it is still true of it.
    server.onGraphql("Translate", (body) => {
      const { input } = body["variables"] as { input: { targetLanguage: string } };
      return input.targetLanguage === "JA"
        ? translated("日本語", "The language, not the country.", "EN", "JA", "日本語《にほんご》", [
            gloss("日本語", 0, "The Japanese language.", "にほんご"),
          ])
        : translated("The Japanese language", null, "JA", "EN");
    });
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Japanese");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Swap languages" }));
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await within(result).findByText("The Japanese language")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Swap languages" }));

    // The Japanese pane is showing the identical 日本語 it showed three clicks ago. The answer that
    // wrote it — and the readings over it, the definition under it and the note beside it — was
    // evicted by the answer made *out of* it, which changed none of those characters. The pane then
    // painted itself up to date over strictly less than it had, so nothing on screen gave the
    // reader a reason to re-translate against the per-session translation limits for text that
    // had not moved.
    expect(within(result).getByText("日本語", { selector: "ruby" })).toBeInTheDocument();
    expect(readings(result)).toEqual(["にほんご"]);
    expect(within(result).getByRole("button", { name: "日本語" })).toBeInTheDocument();
    expect(within(result).getByText("The language, not the country.")).toBeInTheDocument();
    // And it really is current: the pair on screen is the second answer's, reversed.
    expectUpToDate(result);
    expect(server.requests.filter((request) => request.body["operationName"] === "Translate")).toHaveLength(2);
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

  it("caps how far the source pane may grow, in the CSS the hook reads its ceiling from", async () => {
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");

    await user.click(source);
    await user.paste("a".repeat(10_001));

    // Uncapped, the pane grows with the paste and takes the column with it: the gloss picker, the
    // counter and Update Translation go below the fold — worst here, where the button is disabled
    // and this is the only sentence saying why. jsdom lays nothing out, so what can be asserted in
    // this suite is that the ceiling is on the element at all; useAutoGrowTextarea's own suite
    // proves what the hook does with one, and that it hands the clamped box a scrollbar.
    expect(source.className).toMatch(/\bmax-h-\[/);
    expect(source).toHaveClass("overflow-hidden");
    expect(screen.getByText(/Too long to translate/)).toBeInTheDocument();
  });

  it("gives the source textarea a focus indicator rather than suppressing its outline", async () => {
    await renderSignedIn();

    // It used to carry `focus:outline-none` and nothing else, making it the one control on the
    // page a keyboard user could focus with no visible sign of it — worse than the faint rings
    // elsewhere, which are at least there. `focus-ring` is the shared utility whose contrast
    // index.css.test.ts holds to 3:1.
    const source = screen.getByLabelText("Text to translate");

    expect(source).toHaveClass("focus-ring");
    expect(source.className).not.toMatch(/\bfocus:outline-none\b/);
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
                message: "You're sending requests to Claude quickly.",
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

    expect(await screen.findByText("You're sending requests to Claude quickly. Try again in 30 seconds.")).toBeInTheDocument();
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
                message: "This device has reached today's limit of Claude requests.",
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
      await screen.findByText("This device has reached today's limit of Claude requests. It resets in 17 hours."),
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

  it("keeps each language's readings, note and freshness when another direction is answered in between", async () => {
    server.onGraphql("Translate", (body) => {
      const { input } = body["variables"] as { input: { targetLanguage: string } };
      return input.targetLanguage === "JA"
        ? translated("日本語", "The language, not the country.", "EN", "JA", "日本語《にほんご》")
        : translated("japonés", "Lower case in Spanish.", "EN", "ES");
    });
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Japanese");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const result = screen.getByRole("region", { name: "Translation result" });
    await waitFor(() => expect(result.querySelectorAll("ruby")).toHaveLength(1));

    // A second direction out of the same, unedited English. The furigana, the note and the
    // shortfall flags used to live in one page-wide slot that this answer overwrote — so the
    // Japanese came back bare and marked out of date, for a re-translate against the per-session
    // translation limits that would have returned the identical text.
    await pickLanguage(user, "Target language", /Spanish/);
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    expect(await within(result).findByText("japonés")).toBeInTheDocument();
    expect(within(result).getByText("Lower case in Spanish.")).toBeInTheDocument();

    await pickLanguage(user, "Target language", /Japanese/);

    expect(within(result).getByText("日本語")).toBeInTheDocument();
    expect(readings(result)).toEqual(["にほんご"]);
    expect(within(result).getByText("The language, not the country.")).toBeInTheDocument();
    // Same source text, same context, same gloss level, same pair: nothing here is out of date,
    // and the two requests above are all this interaction may cost.
    expectUpToDate(result);
    expect(server.requests.filter((request) => request.body["operationName"] === "Translate")).toHaveLength(2);

    // Spanish kept its own answer through all of that, rather than the two languages sharing one.
    await pickLanguage(user, "Target language", /Spanish/);

    expect(within(result).getByText("japonés")).toBeInTheDocument();
    expect(within(result).getByText("Lower case in Spanish.")).toBeInTheDocument();
    expectUpToDate(result);
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

  it("keeps a draft typed into the far pane after the pickers swapped mid-request", async () => {
    let respond: (response: Response) => void = () => undefined;
    server.onGraphql("Translate", () => new Promise<Response>((resolve) => (respond = resolve)));
    const user = await renderSignedIn();
    const source = screen.getByLabelText("Text to translate");
    await user.type(source, "Hello");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));

    // The swap button is disabled for the 5-20s the call takes; the pickers are not. Choosing the
    // target language as the source swaps the pair, so the Japanese side becomes the editable box
    // — and what gets typed there is a draft with no undo, exactly like the source pane's.
    await pickLanguage(user, "Source language", /Japanese/);
    await user.type(source, "自分で書いた下書き");
    respond(translated("こんにちは", null));

    // The response still settles the pair it asked about: English is now the far pane and holds
    // the text Claude was given. But it may not write こんにちは over the draft on the way past.
    const result = screen.getByRole("region", { name: "Translation result" });
    expect(await within(result).findByText("Hello")).toBeInTheDocument();
    expect(source).toHaveValue("自分で書いた下書き");
    // And having not written it, the pane must not claim the draft beside it is what was answered.
    expectOutOfDate(result);
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

  it("keeps a glossed word selectable, so the translation can be copied out", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const word = await screen.findByRole("button", { name: "バット" });

    // jsdom has no selection to drag, so this asserts the two things a browser needs of the word.
    // First, that its text is selectable at all: a UA stylesheet hands a control user-select: none.
    expect(word).toHaveClass("select-text");

    // Second, that a drag which happens to begin and end on it — which the browser reports as a
    // click — finishes the selection instead of opening a card over the text being copied.
    fireEvent.pointerDown(word, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(word, { clientX: 60, clientY: 12 });
    fireEvent.click(word);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // A press and release in the same place still opens one, so the touch path pays nothing for it.
    await user.click(word);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("underlines a glossed word with a decoration that clears the 3:1 non-text minimum", async () => {
    server.onGraphql("Translate", () =>
      translated("これはバットですか？", null, "EN", "JA", null, [gloss("バット", 3, "Baseball bat.")]),
    );
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");
    await user.click(screen.getByRole("button", { name: "Update Translation" }));
    const word = await screen.findByRole("button", { name: "バット" });

    // The dotted underline is the only mark saying this word has a definition, which makes it a
    // non-text UI indicator under WCAG 1.4.11. --color-frame-muted at 80% is 4.0:1 on
    // --color-frame and 3.7:1 on --color-frame-stale, the two grounds the pane can be on; at the
    // /50 this replaces it was 2.2:1 and 2.1:1, under the minimum on both.
    expect(word).toHaveClass("decoration-frame-muted/80");
    expect(word).toHaveClass("decoration-dotted");
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
    // The word itself is the accessible name, exactly — the readings inside it being aria-hidden,
    // so a browser has nothing to fold in ("天気てんき, button" is what that used to sound like).
    // The reading is still announced from the card, which shows it beside the word.
    const word = await within(result).findByRole("button", { name: "天気" });
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
