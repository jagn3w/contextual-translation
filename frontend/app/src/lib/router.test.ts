import { navigate, parseRoute, routePath } from "./router.ts";

describe("parseRoute", () => {
  it("reads the two pages and an entry id", () => {
    expect(parseRoute("/")).toEqual({ page: "phrases" });
    expect(parseRoute("/diary")).toEqual({ page: "diary", entryId: null });
    expect(parseRoute("/diary/")).toEqual({ page: "diary", entryId: null });
    expect(parseRoute("/diary/42")).toEqual({ page: "diary", entryId: "42" });
  });

  it("falls back to Phrases for anything else", () => {
    expect(parseRoute("/nowhere")).toEqual({ page: "phrases" });
    expect(parseRoute("/diary/1/2")).toEqual({ page: "phrases" });
    expect(parseRoute("/diaryx")).toEqual({ page: "phrases" });
  });

  it("round-trips with routePath", () => {
    // Entry ids are opaque strings: in production a random UUID.
    const uuid = "/diary/0b6f3c52-8d1e-4a7b-9c2d-5e4f6a7b8c9d";
    for (const path of ["/", "/diary", "/diary/abc-1", uuid]) expect(routePath(parseRoute(path))).toBe(path);
  });
});

describe("navigate", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("pushes a history entry and tells listeners", () => {
    const heard = vi.fn();
    window.addEventListener("app:navigated", heard);
    const before = window.history.length;

    navigate("/diary");

    expect(window.location.pathname).toBe("/diary");
    expect(window.history.length).toBe(before + 1);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("app:navigated", heard);
  });

  it("replaces instead when asked, and does nothing for the current path", () => {
    const before = window.history.length;
    navigate("/diary/1", { replace: true });
    navigate("/diary/1");

    expect(window.location.pathname).toBe("/diary/1");
    expect(window.history.length).toBe(before);
  });
});
