import { act, renderHook } from "@testing-library/react";
import { useAutosave } from "./useAutosave.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A save whose promise the test settles by hand. */
function controlledSave() {
  const calls: Array<{ value: string; resolve: (ok: boolean) => void }> = [];
  const save = vi.fn(
    (value: string) =>
      new Promise<boolean>((resolve) => {
        calls.push({ value, resolve });
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
});
