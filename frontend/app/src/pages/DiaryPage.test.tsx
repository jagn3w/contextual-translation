import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App.tsx";
import { diaryErrorMessage } from "./DiaryPage.tsx";
import { entry, localIso } from "../test/diaryFixtures.ts";
import { type FakeDiary, installFakeDiary } from "../test/fakeDiary.ts";
import { type FakeServer, installFakeServer, json, unauthenticated, viewer } from "../test/fakeServer.ts";
import type { TranslateErrorCode } from "../gql/graphql.ts";
import type { DiaryEntry } from "../lib/diary.ts";

let server: FakeServer;

async function openDiary(path: string, initial: DiaryEntry[] = []): Promise<{ user: ReturnType<typeof userEvent.setup>; diary: FakeDiary }> {
  window.history.replaceState(null, "", path);
  server.onGraphql("Viewer", () => viewer());
  const diary = installFakeDiary(server, initial);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "New entry" });
  return { user, diary };
}

function list() {
  return within(screen.getByRole("navigation", { name: "Diary entries" }));
}

function requestsFor(operation: string) {
  return server.requests.filter((request) => request.body["operationName"] === operation);
}

function variablesOf(operation: string, index = -1) {
  return (requestsFor(operation).at(index)?.body["variables"] as { input: Record<string, unknown> }).input;
}

/** Picks from a Radix Select by keyboard (jsdom can't fire its pointer events). */
async function pick(user: ReturnType<typeof userEvent.setup>, picker: string, name: RegExp) {
  screen.getByRole("combobox", { name: picker }).focus();
  await user.keyboard("{ArrowDown}");
  const option = await screen.findByRole("option", { name });
  option.focus();
  await user.keyboard("{Enter}");
}

/** Writes a fresh entry and asks for feedback, leaving the page on its Feedback view. */
async function writeAndReview(user: ReturnType<typeof userEvent.setup>, text = "山を行きました。楽しかったです。") {
  await user.click(screen.getByRole("button", { name: "New entry" }));
  await user.type(await screen.findByLabelText("Diary entry"), text);
  await user.click(screen.getByRole("button", { name: "Get feedback" }));
  await screen.findByRole("button", { name: /^Needs fixing:/ });
}

const MORNING = entry({
  id: "e1",
  body: "朝ご飯を食べました。",
  preview: "朝ご飯を食べました。",
  createdAt: localIso(2026, 9, 20, 8, 0),
});
const EVENING = entry({
  id: "e2",
  language: "ES",
  notesLanguage: "EN",
  body: "Hoy fui al cine.",
  preview: "Hoy fui al cine.",
  createdAt: localIso(2026, 9, 20, 21, 0),
});

beforeEach(() => {
  server = installFakeServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("DiaryPage", () => {
  it("lists the entries and opens one from the list", async () => {
    const { user } = await openDiary("/diary", [EVENING, MORNING]);

    expect(await screen.findByText("Choose an entry, or start a new one.")).toBeInTheDocument();
    const links = await list().findAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/diary/e2", "/diary/e1"]);

    await user.click(list().getByRole("link", { name: /朝ご飯/ }));

    expect(window.location.pathname).toBe("/diary/e1");
    expect(await screen.findByLabelText("Diary entry")).toHaveValue("朝ご飯を食べました。");
    expect(list().getByRole("link", { name: /朝ご飯/ })).toHaveAttribute("aria-current", "page");
  });

  it("creates a new entry in the most recent entry's language pair", async () => {
    const { user } = await openDiary("/diary", [EVENING, MORNING]);
    await list().findAllByRole("link");

    await user.click(screen.getByRole("button", { name: "New entry" }));

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/diary\/n\d+$/));
    expect(variablesOf("CreateDiaryEntry")).toEqual({ language: "ES", notesLanguage: "EN" });
    expect(await screen.findByRole("combobox", { name: "Writing in" })).toHaveTextContent("Spanish");
    expect(list().getAllByRole("link")).toHaveLength(3);
    expect(list().getAllByRole("link")[0]).toHaveAttribute("aria-current", "page");
  });

  it("starts a first entry in Japanese with English notes", async () => {
    const { user } = await openDiary("/diary");
    expect(await screen.findByText(/No entries yet/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New entry" }));

    await screen.findByLabelText("Diary entry");
    expect(variablesOf("CreateDiaryEntry")).toEqual({ language: "JA", notesLanguage: "EN" });
  });

  it("autosaves as the learner writes and updates the list's preview", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);

    const box = await screen.findByLabelText("Diary entry");
    await user.type(box, "美味しかったです。");

    expect(await screen.findByText("Saved", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(variablesOf("SaveDiaryEntry")).toEqual({ id: "e1", body: "朝ご飯を食べました。美味しかったです。" });
    expect(list().getByRole("link", { name: /美味しかったです/ })).toBeInTheDocument();
  });

  it("gets feedback and draws each sentence's verdict, with the entry's notes beside it", async () => {
    const { user } = await openDiary("/diary");

    await writeAndReview(user);

    expect(screen.getByRole("button", { name: "Needs fixing: 山を行きました。" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Natural: 楽しかったです。" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feedback" })).toHaveAttribute("aria-pressed", "true");
    const notes = screen.getByRole("region", { name: "Notes on this entry" });
    expect(within(notes).getByText("Watch your particles")).toBeInTheDocument();
    expect(variablesOf("ReviewDiaryEntry")).toMatchObject({ body: "山を行きました。楽しかったです。" });
  });

  it("asks a follow-up on a sentence and shows Claude's answer in its card", async () => {
    const { user } = await openDiary("/diary");
    await writeAndReview(user);

    await user.click(screen.getByRole("button", { name: /^Needs fixing:/ }));
    const card = await screen.findByRole("dialog", { name: "Feedback: Needs fixing" });
    expect(within(card).getByText("Tip for: 山を行きました。")).toBeInTheDocument();
    await user.type(within(card).getByLabelText("Ask a question about this"), "Should it be に?");
    await user.click(within(card).getByRole("button", { name: "Send" }));

    expect(await within(card).findByText("Answer to: Should it be に?")).toBeInTheDocument();
    expect(within(card).getByText("Should it be に?")).toBeInTheDocument();
    expect(within(card).getByLabelText("Ask a question about this")).toHaveValue("");
  });

  it("resolves a sentence, taking its highlight away", async () => {
    const { user } = await openDiary("/diary");
    await writeAndReview(user);

    await user.click(screen.getByRole("button", { name: /^Needs fixing:/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Resolve" }));

    const resolved = await screen.findByRole("button", { name: "Needs fixing, resolved: 山を行きました。" });
    expect(resolved).not.toHaveClass("bg-verdict-wrong");
    expect(variablesOf("ResolveDiaryThread")).toEqual({ threadId: expect.any(String), resolved: true });
  });

  it("opens a help thread and asks for another hint", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);
    const panel = await screen.findByRole("region", { name: "Help me say…" });

    await user.type(within(panel).getByLabelText(/What do you want to say\?/), "How do I say I went hiking?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));

    expect(await within(panel).findByText("Hint 1: think about the past tense.")).toBeInTheDocument();
    expect(within(panel).getByText("How do I say I went hiking?")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Another hint" }));
    expect(await within(panel).findByText("Hint 2: key vocabulary.")).toBeInTheDocument();
  });

  it("suggests ideas in the entry's languages, following on from what is written", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);

    await user.click(await screen.findByRole("button", { name: "Get ideas" }));

    expect(await screen.findByText("週末に何をしましたか？")).toBeInTheDocument();
    expect(screen.getByText("What did you do at the weekend?")).toBeInTheDocument();
    expect(variablesOf("SuggestDiaryTopics")).toEqual({ language: "JA", notesLanguage: "EN", body: "朝ご飯を食べました。" });
  });

  it("sends the unsaved draft for ideas, and no body for an empty entry", async () => {
    const { user } = await openDiary("/diary/e3", [entry({ id: "e3", body: "", preview: "" })]);

    await user.click(await screen.findByRole("button", { name: "Get ideas" }));
    await screen.findByText("週末に何をしましたか？");
    expect(variablesOf("SuggestDiaryTopics")).toEqual({ language: "JA", notesLanguage: "EN", body: null });

    await user.type(screen.getByLabelText(/diary entry/i), "今日はハンバーガーが食べたかった");
    await user.click(screen.getByRole("button", { name: "Other ideas" }));
    await waitFor(() => expect(requestsFor("SuggestDiaryTopics")).toHaveLength(2));
    expect(variablesOf("SuggestDiaryTopics")["body"]).toBe("今日はハンバーガーが食べたかった");
    // Let the draft's autosave land here: left pending, it would fire on unmount after the fake
    // server is gone, and its failure toast would leak into the next test.
    expect(await screen.findByText("Saved", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("deletes an entry after a confirmation, leaving its URL and the list", async () => {
    const { user } = await openDiary("/diary/e1", [EVENING, MORNING]);

    await user.click(await screen.findByRole("button", { name: "Delete entry" }));
    const confirm = screen.getByRole("group", { name: "Confirm delete" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(requestsFor("DeleteDiaryEntry")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(window.location.pathname).toBe("/diary"));
    expect(variablesOf("DeleteDiaryEntry")).toEqual({ id: "e1" });
    expect(list().getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/diary/e2"]);
    expect(screen.getByText("Choose an entry, or start a new one.")).toBeInTheDocument();
  });

  it("changes an empty entry's languages, swapping when one side takes the other's", async () => {
    const { user } = await openDiary("/diary");
    await user.click(screen.getByRole("button", { name: "New entry" }));
    await screen.findByRole("combobox", { name: "Writing in" });

    await pick(user, "Writing in", /Spanish/);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Writing in" })).toHaveTextContent("Spanish"));
    expect(variablesOf("SaveDiaryEntry")).toMatchObject({ language: "ES", notesLanguage: "EN" });

    await pick(user, "Notes in", /Spanish/);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Notes in" })).toHaveTextContent("Spanish"));
    expect(variablesOf("SaveDiaryEntry")).toMatchObject({ language: "EN", notesLanguage: "ES" });
    expect(screen.getByLabelText("Diary entry")).toHaveAttribute("lang", "en");
  });

  it("shows a typed failure as a toast and keeps the learner's text", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);
    server.onGraphql("ReviewDiaryEntry", () =>
      json({
        data: {
          reviewDiaryEntry: {
            __typename: "DiaryEntryPayload",
            entry: null,
            errors: [
              {
                __typename: "TranslateError",
                code: "UPSTREAM_RATE_LIMITED",
                message: "busy",
                retryable: true,
                retryAfterSeconds: null,
              },
            ],
          },
        },
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Get feedback" }));

    expect(await screen.findByText("Claude is busy — try again in a moment.")).toBeInTheDocument();
    expect(screen.getByLabelText("Diary entry")).toHaveValue("朝ご飯を食べました。");
    expect(screen.getByRole("button", { name: "Write" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a follow-up question in its box when the reply fails", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);
    const panel = await screen.findByRole("region", { name: "Help me say…" });
    server.onGraphql("StartDiaryHelpThread", () => {
      throw new TypeError("Failed to fetch");
    });

    await user.type(within(panel).getByLabelText(/What do you want to say\?/), "How do I say it rained?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Couldn't reach the server. Check your connection and try again.")).toBeInTheDocument();
    expect(within(panel).getByLabelText(/What do you want to say\?/)).toHaveValue("How do I say it rained?");
  });

  it("moves the focus to the feedback when a ⌘/Ctrl+Enter review takes the textarea away", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    await user.click(await screen.findByLabelText("Diary entry"));
    await user.keyboard("{Control>}{Enter}{/Control}");

    const feedback = await screen.findByRole("region", { name: "Claude's feedback" });
    await waitFor(() => expect(feedback).toHaveFocus());
    expect(status).toHaveTextContent("Feedback ready.");
  });

  it("saves a pending draft before signing out, and signs out without a session-ended notice", async () => {
    const { user, diary } = await openDiary("/diary/e1", [MORNING]);
    let signedIn = true;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onSession("DELETE", () => {
      signedIn = false;
      return new Response(null, { status: 204 });
    });

    await user.type(await screen.findByLabelText("Diary entry"), "美味しかった。");
    // Straight away, inside the autosave's pause.
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByLabelText("Access code")).toBeInTheDocument();
    const saveAt = server.requests.findIndex((request) => request.body["operationName"] === "SaveDiaryEntry");
    const signOutAt = server.requests.findIndex((request) => request.method === "DELETE");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeLessThan(signOutAt);
    expect(diary.find("e1")?.body).toBe("朝ご飯を食べました。美味しかった。");
    expect(screen.queryByText(/session ended/i)).not.toBeInTheDocument();
  });

  it("doesn't call a deliberate sign-out an ended session when a request still out comes back refused", async () => {
    const { user } = await openDiary("/diary/e1", [MORNING]);
    let signedIn = true;
    server.onGraphql("Viewer", () => (signedIn ? viewer() : unauthenticated()));
    server.onSession("DELETE", () => {
      signedIn = false;
      return new Response(null, { status: 204 });
    });
    let answer: () => void = () => undefined;
    server.onGraphql("StartDiaryHelpThread", () => new Promise<Response>((resolve) => (answer = () => resolve(unauthenticated()))));
    const panel = await screen.findByRole("region", { name: "Help me say…" });

    await user.type(within(panel).getByLabelText(/What do you want to say\?/), "How do I say it rained?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Access code");
    answer();

    await waitFor(() => expect(requestsFor("Viewer").length).toBeGreaterThanOrEqual(2));
    // Give the refused answer time to arrive and be (not) acted on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByLabelText("Access code")).toBeInTheDocument();
    expect(screen.queryByText(/session ended/i)).not.toBeInTheDocument();
  });

  it("treats a malformed entry URL as an entry that doesn't exist", async () => {
    await openDiary("/diary/%ZZ", [MORNING]);
    expect(await screen.findByText("This entry doesn't exist, or belongs to another access code.")).toBeInTheDocument();
  });

  it("says an entry doesn't exist when its id is missing or another code's", async () => {
    await openDiary("/diary/someone-elses", [MORNING]);

    expect(await screen.findByText("This entry doesn't exist, or belongs to another access code.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Diary entry")).not.toBeInTheDocument();
  });
});

describe("diaryErrorMessage", () => {
  const error = (code: TranslateErrorCode, retryAfterSeconds: number | null = null) => ({
    code,
    message: "Server wording.",
    retryable: false,
    retryAfterSeconds,
  });

  it("words the input checks for a diary rather than a translation", () => {
    expect(diaryErrorMessage(error("EMPTY_INPUT"))).toBe("Write something first.");
    expect(diaryErrorMessage(error("SAME_LANGUAGE"))).toMatch(/must be different/);
  });

  it("names every length limit the diary has, from the same constants the page checks", () => {
    expect(diaryErrorMessage(error("INPUT_TOO_LONG"))).toBe(
      "That's over the length limit: 10,000 characters for an entry, 2,000 for feedback at a time, 2,000 for a question or reply. Shorten it and try again.",
    );
  });

  it("says what Claude declined or ran out of time on without calling it a translation", () => {
    for (const code of ["REFUSED", "OUTPUT_TOO_LONG", "TIMEOUT"] as const) {
      const message = diaryErrorMessage(error(code));
      expect(message).toMatch(/Claude/);
      expect(message).not.toMatch(/translat/i);
    }
    expect(diaryErrorMessage(error("REFUSED"))).toBe("Claude declined to answer this. Try rewording it.");
  });

  it("shares every other message with Phrases", () => {
    expect(diaryErrorMessage(error("RATE_LIMITED", 30))).toBe("Server wording. Try again in 30 seconds.");
  });
});
