import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiaryEntry } from "../../lib/diary.ts";
import { comment, entry, localIso, sentenceThread, thread } from "../../test/diaryFixtures.ts";
import { type DiaryActions, DiaryView } from "./DiaryView.tsx";

const NOW = new Date(2026, 8, 21, 20, 0);
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
    id: "e1",
    body: BODY,
    preview: BODY,
    reviewedBody: BODY,
    reviewedAt: localIso(2026, 9, 21, 19, 0),
    createdAt: localIso(2026, 9, 21, 18, 30),
    threads: [
      sentenceThread("wrong", BODY, "昨日、友達と山を行きました。", "WRONG", {
        comments: [comment("TUTOR", "Look at the particle before 行きました: going *to* a place.")],
      }),
      sentenceThread("right", BODY, "とても楽しかったです。", "CORRECT", {
        comments: [comment("TUTOR", "Natural and well formed.")],
      }),
    ],
    ...overrides,
  });
}

function renderView(selected: DiaryEntry | null, handlers = actions(), entries = [selected ?? entry({ id: "x" })]) {
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
      entry({ id: "late", preview: "夜ご飯はカレーでした", createdAt: localIso(2026, 9, 21, 21, 15) }),
      entry({ id: "early", language: "ES", preview: "", createdAt: localIso(2026, 9, 21, 7, 5) }),
      entry({ id: "old", preview: "雨でした", createdAt: localIso(2026, 9, 19, 12, 0) }),
    ];
    renderView(null, actions(), entries);

    const list = screen.getByRole("navigation", { name: "Diary entries" });
    const today = within(list).getByRole("region", { name: "Today" });
    const links = within(today).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/diary/late");
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
    const { user, handlers } = renderView(selected, actions(), [selected, entry({ id: "e0", preview: "前" })]);

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
    expect(handlers.onResolve).toHaveBeenCalledWith("wrong", true);
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

    expect(onReply).toHaveBeenCalledWith("wrong", "Is it に?");
    expect(within(card).getByRole("status")).toHaveTextContent("Asking Claude…");
    expect(box).toHaveValue("Is it に?");
    finish(true);
    await waitFor(() => expect(box).toHaveValue(""));
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
    expect(handlers.onResolve).toHaveBeenCalledWith("wrong", false);
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
    const { user } = renderView(entry({ id: "new", createdAt: localIso(2026, 9, 21, 20, 0) }), handlers);

    expect(screen.getByRole("button", { name: "Feedback" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Get feedback" })).toBeDisabled();
    const box = screen.getByLabelText("Diary entry");
    expect(box).toHaveAttribute("lang", "ja");
    await user.type(box, "山に行きました。");

    expect(screen.getByText("8 / 10,000")).toBeInTheDocument();
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    await waitFor(() => expect(handlers.onSaveBody).toHaveBeenCalledWith("new", "山に行きました。"));
    expect(await screen.findByText("Saved")).toBeInTheDocument();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(handlers.onRequestFeedback).toHaveBeenCalledWith("new", "山に行きました。");
  });

  it("offers the language pickers only while the entry is empty", () => {
    const onChangeLanguages = vi.fn(async () => undefined);
    renderView(entry({ id: "empty" }), actions({ onChangeLanguages }));
    expect(screen.getByRole("combobox", { name: "Writing in" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Notes in" })).toBeInTheDocument();
  });

  it("shows the languages as text once there is writing", () => {
    renderView(reviewed(), actions({ onChangeLanguages: vi.fn(async () => undefined) }));
    expect(screen.queryByRole("combobox", { name: "Writing in" })).not.toBeInTheDocument();
    expect(screen.getByText("Writing in Japanese · notes in English")).toBeInTheDocument();
  });

  it("asks for another hint on a help thread and sends a follow-up", async () => {
    const help = thread({
      id: "h1",
      kind: "HELP",
      sentence: "How do I say I went hiking with my sister?",
      hintLevel: 1,
      comments: [comment("TUTOR", "Think about which past form fits a completed trip.")],
    });
    const { user, handlers } = renderView(reviewed({ threads: [help] }));

    const panel = screen.getByRole("region", { name: "Help me say…" });
    expect(within(panel).getByText("How do I say I went hiking with my sister?")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Another hint" }));
    expect(handlers.onRequestHint).toHaveBeenCalledWith("h1");

    await user.type(within(panel).getByLabelText("Ask something specific"), "What is 'sister'?");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(handlers.onReply).toHaveBeenCalledWith("h1", "What is 'sister'?");
  });

  it("starts a help thread from Help me say…", async () => {
    const { user, handlers } = renderView(reviewed());

    const panel = screen.getByRole("region", { name: "Help me say…" });
    await user.type(within(panel).getByLabelText(/What do you want to say\?/), "How do I say it rained?");
    await user.click(within(panel).getByRole("button", { name: "Ask" }));

    expect(handlers.onStartHelp).toHaveBeenCalledWith("e1", "How do I say it rained?");
  });

  it("lists writing ideas with their glosses", async () => {
    const onSuggestTopics = vi.fn(async () => [
      { prompt: "週末に何をしましたか？", gloss: "What did you do at the weekend?" },
      { prompt: "好きな食べ物は？", gloss: "Your favourite food?" },
      { prompt: "今日の天気", gloss: "Today's weather" },
    ]);
    const { user } = renderView(reviewed(), actions({ onSuggestTopics }));

    await user.click(screen.getByRole("button", { name: "Get ideas" }));

    expect(onSuggestTopics).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("週末に何をしましたか？")).toHaveAttribute("lang", "ja");
    expect(screen.getByText("What did you do at the weekend?")).toHaveAttribute("lang", "en");
  });

  it("keeps entry notes and earlier feedback in the side panel, hiding resolved ones until asked", async () => {
    const selected = reviewed({
      threads: [
        ...reviewed().threads,
        thread({ id: "n1", kind: "ENTRY", title: "Particles of motion", comments: [comment("TUTOR", "に vs を")] }),
        thread({ id: "n2", kind: "ENTRY", title: "Nice use of とても", resolved: true }),
        thread({ id: "old", kind: "SENTENCE", verdict: "IMPROVABLE", sentence: "山を行った。", current: false }),
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
      threads: [thread({ id: "lost", verdict: "WRONG", sentence: "山を行きました", comments: [comment("TUTOR", "Particle.")] })],
    });
    renderView(selected);

    const also = screen.getByRole("region", { name: "Also reviewed" });
    expect(within(also).getByText("山を行きました")).toBeInTheDocument();
    expect(within(also).getByText("Needs fixing")).toBeInTheDocument();
  });
});
