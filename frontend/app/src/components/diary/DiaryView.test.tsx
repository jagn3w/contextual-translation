import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiaryEntry } from "../../lib/diary.ts";
import { comment, entry, localIso, sentenceThread, thread } from "../../test/diaryFixtures.ts";
import { type DiaryActions, DiaryView } from "./DiaryView.tsx";

const NOW = new Date(2026, 8, 21, 20, 0);
// Ids the tests assert on; the rest are random (diaryFixtures.ts).
const ENTRY_ID = "5f0c2b8e-3a1d-4e6f-9b7a-2c4d6e8f0a13";
const OTHER_ENTRY_ID = "a3d91f47-8c2e-4b5a-9e61-7f0b3c5d2e84";
const LATE_ENTRY_ID = "c7e24a90-1b3f-4d8c-a5e2-9f6b0d3c1a57";
const WRONG_THREAD_ID = "e1b8d3f6-4a7c-4f2e-8d09-3b5c7a9e1f26";
const HELP_THREAD_ID = "9d4f6b21-7e3a-4c8d-b1f5-0a2e4c6d8b39";
const BODY = "昨日、友達と山を行きました。とても楽しかったです。";

function actions(overrides: Partial<DiaryActions> = {}): DiaryActions {
  return {
    onNewEntry: vi.fn(async () => undefined),
    onSaveBody: vi.fn(async () => true),
    onRequestFeedback: vi.fn(async () => true),
    onDeleteEntry: vi.fn(async () => true),
    onSuggestTopics: vi.fn(async () => null),
    onStartHelp: vi.fn(async () => true),
    onReply: vi.fn(async () => true),
    onResolve: vi.fn(async () => undefined),
    onRequestHint: vi.fn(async () => undefined),
    ...overrides,
  };
}

function reviewed(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return entry({
    id: ENTRY_ID,
    body: BODY,
    preview: BODY,
    reviewedBody: BODY,
    reviewedAt: localIso(2026, 9, 21, 19, 0),
    createdAt: localIso(2026, 9, 21, 18, 30),
    threads: [
      sentenceThread(WRONG_THREAD_ID, BODY, "昨日、友達と山を行きました。", "WRONG", {
        comments: [comment("TUTOR", "Look at the particle before 行きました: going *to* a place.")],
      }),
      sentenceThread(crypto.randomUUID(), BODY, "とても楽しかったです。", "CORRECT", {
        comments: [comment("TUTOR", "Natural and well formed.")],
      }),
    ],
    ...overrides,
  });
}

function renderView(selected: DiaryEntry | null, handlers = actions(), entries = [selected ?? entry()]) {
  const user = userEvent.setup();
  render(
    <DiaryView
      entries={entries}
      selectedId={selected?.id ?? null}
      entry={selected}
      entryLoading={false}
      actions={handlers}
      now={NOW}
    />,
  );
  return { user, handlers };
}

describe("DiaryView", () => {
  it("groups the scrollback by day, with the time and language telling same-day entries apart", () => {
    const entries = [
      entry({ id: LATE_ENTRY_ID, preview: "夜ご飯はカレーでした", createdAt: localIso(2026, 9, 21, 21, 15) }),
      entry({ language: "ES", preview: "", createdAt: localIso(2026, 9, 21, 7, 5) }),
      entry({ preview: "雨でした", createdAt: localIso(2026, 9, 19, 12, 0) }),
    ];
    renderView(null, actions(), entries);

    const list = screen.getByRole("navigation", { name: "Diary entries" });
    const today = within(list).getByRole("region", { name: "Today" });
    const links = within(today).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", `/diary/${LATE_ENTRY_ID}`);
    expect(links[0]).toHaveTextContent("夜ご飯はカレーでした");
    expect(links[0]).toHaveTextContent("Japanese");
    expect(links[1]).toHaveTextContent("Spanish");
    expect(links[1]).toHaveTextContent("Empty entry");
    // Two entries from one day are told apart by their times.
    expect(links[0]?.querySelector("time")?.dateTime).toBe(entries[0]?.createdAt);
    expect(links[0]?.textContent).not.toBe(links[1]?.textContent);
    expect(within(list).getByRole("region", { name: "Sat, Sep 19" })).toBeInTheDocument();
  });

  it("marks the open entry and starts a new one from New entry", async () => {
    const selected = reviewed();
    const { user, handlers } = renderView(selected, actions(), [selected, entry({ preview: "前" })]);

    expect(screen.getByRole("link", { name: /とても楽しかった/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /前/ })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "New entry" }));
    expect(handlers.onNewEntry).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state with no entries", () => {
    renderView(null, actions(), []);
    expect(screen.getByText(/No entries yet/)).toBeInTheDocument();
    expect(screen.getByText(/Start with New entry/)).toBeInTheDocument();
  });

  it("opens reviewed text in Feedback, each sentence named by its verdict", () => {
    renderView(reviewed());

    const wrong = screen.getByRole("button", { name: "Needs fixing: 昨日、友達と山を行きました。" });
    const right = screen.getByRole("button", { name: "Natural: とても楽しかったです。" });
    expect(wrong).toHaveAttribute("data-verdict", "WRONG");
    expect(wrong).toHaveClass("bg-verdict-wrong", "decoration-wavy");
    expect(right).toHaveClass("bg-verdict-correct", "decoration-solid");
    expect(screen.getByRole("button", { name: "Feedback" })).toHaveAttribute("aria-pressed", "true");
    const legend = screen.getByRole("group", { name: "Legend" });
    expect(legend).toHaveTextContent("Needs fixing");
    expect(legend).toHaveTextContent("Could be better");
    expect(legend).toHaveTextContent("Natural");
    expect(screen.queryByText("Edited since this feedback.")).not.toBeInTheDocument();
  });

  it("opens a sentence's card with Claude's tip, and resolves it", async () => {
    const { user, handlers } = renderView(reviewed());

    await user.click(screen.getByRole("button", { name: /^Needs fixing:/ }));

    const card = await screen.findByRole("dialog", { name: "Feedback: Needs fixing" });
    expect(within(card).getByText(/Look at the particle/)).toBeInTheDocument();
    expect(within(card).getByText("Claude")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Resolve" }));
    expect(handlers.onResolve).toHaveBeenCalledWith(WRONG_THREAD_ID, true);
  });

  it("sends a question from the card and clears the box once it's in", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onReply = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const { user } = renderView(reviewed(), actions({ onReply }));

    await user.click(screen.getByRole("button", { name: /^Needs fixing:/ }));
    const card = await screen.findByRole("dialog");
    const box = within(card).getByLabelText("Ask a question about this");
    await user.type(box, "Is it に?");
    await user.click(within(card).getByRole("button", { name: "Send" }));

    expect(onReply).toHaveBeenCalledWith(WRONG_THREAD_ID, "Is it に?");
    expect(screen.getByRole("status")).toHaveTextContent("Asking Claude…");
    expect(box).toHaveValue("Is it に?");
    // Resolving under a reply still on its way would race it; it waits, as Send does.
    expect(within(card).getByRole("button", { name: "Resolve" })).toBeDisabled();
    finish(true);
    await waitFor(() => expect(box).toHaveValue(""));
    expect(screen.getByRole("status")).toHaveTextContent("Reply received.");
    expect(within(card).getByRole("button", { name: "Resolve" })).toBeEnabled();
  });

  it("scrolls a reply that lands in the card into view", async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const view = (selected: DiaryEntry) => (
      <DiaryView entries={[selected]} selectedId={ENTRY_ID} entry={selected} entryLoading={false} actions={handlers} now={NOW} />
    );
    const { rerender } = render(view(reviewed()));
    await user.click(screen.getByRole("button", { name: /^Needs fixing:/ }));
    const card = await screen.findByRole("dialog");
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    // Opening the card brings nothing into view: only a comment that arrives while it is open.
    expect(scrolled).not.toHaveBeenCalled();

    const answered = reviewed();
    const [wrong] = answered.threads;
    if (wrong === undefined) throw new Error("no thread");
    wrong.comments = [...wrong.comments, comment("LEARNER", "Is it に?"), comment("TUTOR", "Yes: 山に行きました.")];
    rerender(view(answered));

    const newest = within(card).getByText("Yes: 山に行きました.").closest("li");
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(newest);
    scrolled.mockRestore();
  });

  it("keeps Resolve disabled while a hint is on its way", async () => {
    let finish: () => void = () => undefined;
    const onRequestHint = vi.fn(() => new Promise<boolean>((resolve) => (finish = () => resolve(true))));
    const help = thread({ id: HELP_THREAD_ID, kind: "HELP", sentence: "How do I say it rained?", hintLevel: 0 });
    const { user } = renderView(reviewed({ threads: [help] }), actions({ onRequestHint }));

    const panel = screen.getByRole("region", { name: "Help me say…" });
    await user.click(within(panel).getByRole("button", { name: "Another hint" }));

    expect(within(panel).getByRole("button", { name: "Resolve" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Asking Claude…");
    finish();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Resolve" })).toBeEnabled());
    expect(screen.getByRole("status")).toHaveTextContent("Hint received.");
  });

  it("has one live region, mounted empty, for the diary's announcements", () => {
    renderView(reviewed());
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();
  });

  it("draws a resolved sentence without its wash, still open to reopening", async () => {
    const selected = reviewed();
    selected.threads[0] = { ...selected.threads[0]!, resolved: true };
    const { user, handlers } = renderView(selected);

    const resolved = screen.getByRole("button", { name: /^Needs fixing, resolved:/ });
    expect(resolved).not.toHaveClass("bg-verdict-wrong");
    expect(resolved).toHaveClass("decoration-dotted");
    await user.click(resolved);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reopen" }));
    expect(handlers.onResolve).toHaveBeenCalledWith(WRONG_THREAD_ID, false);
  });

  it("says when the text has changed since the feedback", async () => {
    const { user } = renderView(reviewed());

    await user.click(screen.getByRole("button", { name: "Write" }));
    await user.type(screen.getByLabelText("Diary entry"), "雨でした。");
    await user.click(screen.getByRole("button", { name: "Feedback" }));

    expect(screen.getByText("Edited since this feedback.")).toBeInTheDocument();
  });

  it("writes in Write mode with a count, saves as it goes and asks for feedback with ⌘/Ctrl+Enter", async () => {
    const handlers = actions();
    const { user } = renderView(entry({ id: ENTRY_ID, createdAt: localIso(2026, 9, 21, 20, 0) }), handlers);

    expect(screen.getByRole("button", { name: "Feedback" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Get feedback" })).toBeDisabled();
    const box = screen.getByLabelText("Diary entry");
    expect(box).toHaveAttribute("lang", "ja");
    await user.type(box, "山に行きました。");

    expect(screen.getByText("8 / 10,000")).toBeInTheDocument();
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await waitFor(() => expect(handlers.onSaveBody).toHaveBeenCalledWith(ENTRY_ID, "山に行きました。"));
    expect(await screen.findByText("Saved")).toBeInTheDocument();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(handlers.onRequestFeedback).toHaveBeenCalledWith(ENTRY_ID, "山に行きました。");
  });

  it("offers Get feedback only up to the feedback limit, and says why", () => {
    renderView(entry({ body: "あ".repeat(2_001) }));

    expect(screen.getByRole("button", { name: "Get feedback" })).toBeDisabled();
    expect(screen.getByText(/Feedback works on up to 2,000 characters at a time/)).toHaveTextContent("2,001 / 10,000");
    expect(screen.getByRole("button", { name: "Get feedback" })).toHaveAccessibleDescription(
      /Feedback works on up to 2,000 characters/,
    );
  });

  it("says when an entry is too long to save at all", () => {
    renderView(entry({ body: "あ".repeat(10_001) }));
    expect(screen.getByText(/Too long to save/)).toHaveTextContent("10,001 / 10,000");
  });

  it("sends again what was typed while a review was out, once the review has saved its own text", async () => {
    let finishReview: (ok: boolean) => void = () => undefined;
    const handlers = actions({
      onRequestFeedback: vi.fn(() => new Promise<boolean>((resolve) => (finishReview = resolve))),
    });
    const { user } = renderView(entry({ id: ENTRY_ID, body: "山に行きました。" }), handlers);

    await user.click(screen.getByRole("button", { name: "Get feedback" }));
    await user.type(screen.getByLabelText("Diary entry"), "雨でした。");
    await waitFor(() => expect(handlers.onSaveBody).toHaveBeenCalledWith(ENTRY_ID, "山に行きました。雨でした。"));
    expect(handlers.onSaveBody).toHaveBeenCalledTimes(1);

    // The review lands after that save, writing the text it was sent over the newer draft.
    finishReview(true);
    await waitFor(() => expect(handlers.onSaveBody).toHaveBeenCalledTimes(2));
    expect(handlers.onSaveBody).toHaveBeenLastCalledWith(ENTRY_ID, "山に行きました。雨でした。");
  });

  it("comes back to a draft whose save hasn't landed instead of the older cached body", async () => {
    const saves: Array<(ok: boolean) => void> = [];
    const onSaveBody = vi.fn(() => new Promise<boolean>((resolve) => saves.push(resolve)));
    const handlers = actions({ onSaveBody });
    const first = entry({ id: ENTRY_ID, body: "朝" });
    const other = entry({ id: OTHER_ENTRY_ID, body: "夜" });
    const user = userEvent.setup();
    const view = (selected: DiaryEntry) => (
      <DiaryView entries={[first, other]} selectedId={selected.id} entry={selected} entryLoading={false} actions={handlers} now={NOW} />
    );
    const { rerender } = render(view(first));

    await user.type(screen.getByLabelText("Diary entry"), "ご飯");
    rerender(view(other));
    // Leaving saved the draft on the way out; the cache still has the old body.
    expect(onSaveBody).toHaveBeenCalledWith(ENTRY_ID, "朝ご飯");
    rerender(view(first));

    expect(screen.getByLabelText("Diary entry")).toHaveValue("朝ご飯");
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    saves.forEach((resolve) => resolve(true));
    await waitFor(() => expect(onSaveBody).toHaveBeenCalledTimes(2));
    saves.forEach((resolve) => resolve(true));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(onSaveBody).toHaveBeenLastCalledWith(ENTRY_ID, "朝ご飯");
  });

  it("offers the language pickers only while the entry is empty", () => {
    const onChangeLanguages = vi.fn(async () => undefined);
    renderView(entry(), actions({ onChangeLanguages }));
    expect(screen.getByRole("combobox", { name: "Writing in" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Notes in" })).toBeInTheDocument();
  });

  it("locks the languages once the entry has a thread, even with nothing written", () => {
    const help = thread({ id: HELP_THREAD_ID, kind: "HELP", sentence: "How do I say it rained?" });
    renderView(entry({ threads: [help] }), actions({ onChangeLanguages: vi.fn(async () => undefined) }));
    expect(screen.queryByRole("combobox", { name: "Writing in" })).not.toBeInTheDocument();
    expect(screen.getByText("Writing in Japanese · notes in English")).toBeInTheDocument();
  });

  it("shows the languages as text once there is writing", () => {
    renderView(reviewed(), actions({ onChangeLanguages: vi.fn(async () => undefined) }));
    expect(screen.queryByRole("combobox", { name: "Writing in" })).not.toBeInTheDocument();
    expect(screen.getByText("Writing in Japanese · notes in English")).toBeInTheDocument();
  });

  it("asks for another hint on a help thread and sends a follow-up", async () => {
    const help = thread({
      id: HELP_THREAD_ID,
      kind: "HELP",
      sentence: "How do I say I went hiking with my sister?",
      hintLevel: 1,
      comments: [comment("TUTOR", "Think about which past form fits a completed trip.")],
    });
    const { user, handlers } = renderView(reviewed({ threads: [help] }));

    const panel = screen.getByRole("region", { name: "Help me say…" });
    expect(within(panel).getByText("How do I say I went hiking with my sister?")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Another hint" }));
    expect(handlers.onRequestHint).toHaveBeenCalledWith(HELP_THREAD_ID);

    await user.type(within(panel).getByLabelText("Ask something specific"), "What is 'sister'?");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(handlers.onReply).toHaveBeenCalledWith(HELP_THREAD_ID, "What is 'sister'?");
  });

  it("starts a help thread from Help me say…", async () => {
    const { user, handlers } = renderView(reviewed());

    const panel = screen.getByRole("region", { name: "Help me say…" });
    await user.type(within(panel).getByLabelText(/What do you want to say\?/), "How do I say it rained?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));

    expect(handlers.onStartHelp).toHaveBeenCalledWith(ENTRY_ID, "How do I say it rained?");
  });

  it("lists writing ideas with their glosses", async () => {
    const onSuggestTopics = vi.fn(async () => [
      { prompt: "週末に何をしましたか？", gloss: "What did you do at the weekend?" },
      { prompt: "好きな食べ物は？", gloss: "Your favourite food?" },
      { prompt: "今日の天気", gloss: "Today's weather" },
    ]);
    const { user } = renderView(reviewed(), actions({ onSuggestTopics }));

    await user.click(screen.getByRole("button", { name: "Get ideas" }));

    expect(onSuggestTopics).toHaveBeenCalledWith(ENTRY_ID, reviewed().body);
    expect(await screen.findByText("週末に何をしましたか？")).toHaveAttribute("lang", "ja");
    expect(screen.getByText("What did you do at the weekend?")).toHaveAttribute("lang", "en");
  });

  it("keeps entry notes and earlier feedback in the side panel, hiding resolved ones until asked", async () => {
    const selected = reviewed({
      threads: [
        ...reviewed().threads,
        thread({ kind: "ENTRY", title: "Particles of motion", comments: [comment("TUTOR", "に vs を")] }),
        thread({ kind: "ENTRY", title: "Nice use of とても", resolved: true }),
        thread({ kind: "SENTENCE", verdict: "IMPROVABLE", sentence: "山を行った。", current: false }),
      ],
    });
    const { user } = renderView(selected);

    const notes = screen.getByRole("region", { name: "Notes on this entry" });
    expect(within(notes).getByText("Particles of motion")).toBeInTheDocument();
    expect(within(notes).queryByText("Nice use of とても")).not.toBeInTheDocument();
    const earlier = screen.getByRole("region", { name: "Earlier feedback" });
    expect(within(earlier).getByText("1 comment from an earlier review")).toBeInTheDocument();
    expect(within(earlier).getByText("Could be better")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Show resolved"));
    expect(within(notes).getByText("Nice use of とても")).toBeInTheDocument();
  });

  it("lists a sentence the backend couldn't locate under the text instead of losing it", () => {
    const selected = reviewed({
      threads: [thread({ verdict: "WRONG", sentence: "山を行きました", comments: [comment("TUTOR", "Particle.")] })],
    });
    renderView(selected);

    const also = screen.getByRole("region", { name: "Also reviewed" });
    expect(within(also).getByText("山を行きました")).toBeInTheDocument();
    expect(within(also).getByText("Needs fixing")).toBeInTheDocument();
  });
});
