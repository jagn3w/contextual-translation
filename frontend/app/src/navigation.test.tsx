import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App.tsx";
import { installFakeServer, json, viewer } from "./test/fakeServer.ts";

async function renderSignedIn() {
  const server = installFakeServer();
  server.onGraphql("Viewer", () => viewer());
  server.onGraphql("DiaryEntries", () => json({ data: { diaryEntries: [] } }));
  server.onGraphql("DiaryEntry", () => json({ data: { diaryEntry: null } }));
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Sign out" });
  return user;
}

function menu() {
  return within(screen.getByRole("navigation", { name: "Main" }));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("navigation", () => {
  it("lands on Phrases, marked as the current page", async () => {
    await renderSignedIn();

    expect(menu().getByRole("link", { name: "Phrases" })).toHaveAttribute("aria-current", "page");
    expect(menu().getByRole("link", { name: "Diary" })).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("Text to translate")).toBeVisible();
  });

  it("switches to the diary in place, updating the URL, and back with the back button", async () => {
    const user = await renderSignedIn();

    await user.click(menu().getByRole("link", { name: "Diary" }));

    expect(window.location.pathname).toBe("/diary");
    expect(menu().getByRole("link", { name: "Diary" })).toHaveAttribute("aria-current", "page");
    expect(menu().getByRole("link", { name: "Phrases" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "New entry" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Text to translate")).not.toBeVisible();

    act(() => {
      window.history.back();
    });
    // jsdom runs history traversal asynchronously and fires popstate when it lands.
    await screen.findByLabelText("Text to translate");
    await vi.waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.getByLabelText("Text to translate")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New entry" })).not.toBeInTheDocument();
    expect(menu().getByRole("link", { name: "Phrases" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a Phrases draft across a trip to the diary", async () => {
    const user = await renderSignedIn();
    await user.type(screen.getByLabelText("Text to translate"), "Is this a bat?");

    await user.click(menu().getByRole("link", { name: "Diary" }));
    await user.click(menu().getByRole("link", { name: "Phrases" }));

    expect(screen.getByLabelText("Text to translate")).toHaveValue("Is this a bat?");
  });

  it("leaves a modified click to the browser", async () => {
    await renderSignedIn();

    const diary = menu().getByRole("link", { name: "Diary" });
    // A ctrl/cmd-click opens a new tab: the handler must not swallow it or navigate this tab. The
    // document listener runs after React's and records what the app left for the browser — then
    // takes the default itself, since jsdom can't open a tab and would try to load the page.
    let leftToBrowser: boolean | null = null;
    const observe = (event: Event) => {
      leftToBrowser = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", observe);
    fireEvent.click(diary, { ctrlKey: true });
    document.removeEventListener("click", observe);

    expect(leftToBrowser).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(diary).toHaveAttribute("href", "/diary");
  });

  it("opens an entry's URL directly on the diary", async () => {
    window.history.replaceState(null, "", "/diary/7");
    await renderSignedIn();
    expect(menu().getByRole("link", { name: "Diary" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("This entry doesn't exist, or belongs to another access code.")).toBeInTheDocument();
  });

  it("shows Phrases for a path it doesn't know", async () => {
    window.history.replaceState(null, "", "/somewhere-else");
    await renderSignedIn();

    expect(menu().getByRole("link", { name: "Phrases" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Text to translate")).toBeVisible();
  });
});
