import { act, cleanup, renderHook } from "@testing-library/react";
import { flushAutosaves, useAutosave } from "./useAutosave.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

// Every save any test left unsettled. The hooks register with a module-level list that sign-out
// awaits (flushAutosaves), so one left hanging would stall a later test's flush.
const unsettled: Array<(ok: boolean) => void> = [];

afterEach(async () => {
  // Unmount first — that sends each hook's last save — then let every save land.
  cleanup();
  while (unsettled.length > 0) await act(async () => unsettled.shift()?.(true));
  vi.useRealTimers();
});

/** A save whose promise the test settles by hand. */
function controlledSave() {
  const calls: Array<{ value: string; resolve: (ok: boolean) => void }> = [];
  const save = vi.fn(
    (value: string) =>
      new Promise<boolean>((resolve) => {
        calls.push({ value, resolve });
        unsettled.push(resolve);
      }),
  );
  return { save, calls };
}

describe("useAutosave", () => {
  it("treats the first value as saved", () => {
    const { save } = controlledSave();
    const { result } = renderHook(() => useAutosave("hello", save));

    expect(result.current.state).toBe("idle");
    act(() => vi.advanceTimersByTime(5000));
    expect(save).not.toHaveBeenCalled();
  });

  it("says saving at once, saves after the pause, then says saved", async () => {
    const { save, calls } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 800), {
      initialProps: { value: "" },
    });

    rerender({ value: "今日は" });
    expect(result.current.state).toBe("saving");
    act(() => vi.advanceTimersByTime(799));
    expect(save).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledWith("今日は");

    await act(async () => calls[0]?.resolve(true));
    expect(result.current.state).toBe("saved");
  });

  it("sends one request at a time, following up with what was typed during it", async () => {
    const { save, calls } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 100), {
      initialProps: { value: "" },
    });

    rerender({ value: "a" });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: "ab" });
    act(() => vi.advanceTimersByTime(100));
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => calls[0]?.resolve(true));
    expect(save).toHaveBeenLastCalledWith("ab");
    await act(async () => calls[1]?.resolve(true));
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("saved");
  });

  it("reports a failed save until the next attempt", async () => {
    const { save, calls } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 100), {
      initialProps: { value: "" },
    });

    rerender({ value: "x" });
    act(() => vi.advanceTimersByTime(100));
    await act(async () => calls[0]?.resolve(false));
    expect(result.current.state).toBe("error");

    rerender({ value: "xy" });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.state).toBe("saving");
  });

  it("saves pending text on unmount instead of dropping it", () => {
    const { save } = controlledSave();
    const { rerender, unmount } = renderHook(({ value }) => useAutosave(value, save, 800), {
      initialProps: { value: "" },
    });

    rerender({ value: "draft" });
    unmount();

    expect(save).toHaveBeenCalledWith("draft");
  });

  it("skips the save when told the server already has the text", () => {
    const { save } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 100), {
      initialProps: { value: "" },
    });

    rerender({ value: "reviewed" });
    act(() => result.current.markSaved("reviewed"));
    act(() => vi.advanceTimersByTime(1000));

    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("saved");
  });

  it("resends the draft when a review saved older text over a newer save", async () => {
    const { save, calls } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 100), {
      initialProps: { value: "A" },
    });

    // Get feedback went out with "A"; the learner typed on, and that save landed first.
    rerender({ value: "AB" });
    act(() => vi.advanceTimersByTime(100));
    await act(async () => calls[0]?.resolve(true));
    expect(result.current.state).toBe("saved");

    // Then the review wrote "A" on the server.
    act(() => result.current.markSaved("A"));
    expect(result.current.state).toBe("saving");
    expect(save).toHaveBeenLastCalledWith("AB");
    await act(async () => calls[1]?.resolve(true));
    expect(result.current.state).toBe("saved");
  });

  it("resends a save that was in flight when a review wrote its own text", async () => {
    const { save, calls } = controlledSave();
    const { result, rerender } = renderHook(({ value }) => useAutosave(value, save, 100), {
      initialProps: { value: "A" },
    });

    rerender({ value: "AB" });
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.markSaved("A"));
    await act(async () => calls[0]?.resolve(true));

    // The server may have got "AB" before the review's "A", so "AB" goes again.
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("AB");
    await act(async () => calls[1]?.resolve(true));
    expect(result.current.state).toBe("saved");
  });

  it("saves the difference after the pause when the draft starts ahead of the server", () => {
    const { save } = controlledSave();
    const { result } = renderHook(() => useAutosave("newer", save, 100, "older"));

    expect(result.current.state).toBe("saving");
    act(() => vi.advanceTimersByTime(100));
    expect(save).toHaveBeenCalledWith("newer");
  });

  it("lets a sign-out wait for every pending save, including one sent on unmount", async () => {
    const { save, calls } = controlledSave();
    const { rerender, unmount } = renderHook(({ value }) => useAutosave(value, save, 800), {
      initialProps: { value: "" },
    });
    rerender({ value: "draft" });
    unmount();

    let flushed = false;
    const waiting = flushAutosaves().then(() => (flushed = true));
    await act(async () => undefined);
    expect(flushed).toBe(false);
    await act(async () => calls[0]?.resolve(true));
    await waiting;
    expect(flushed).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
