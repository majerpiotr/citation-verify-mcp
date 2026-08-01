// test/exit-after-stderr.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exitAfterStderr, type StderrWriter } from "../src/exit-after-stderr.js";

// A fake writer that records what it was asked to write and lets the test decide when
// (or whether) the write "completes" by invoking the captured callback - exactly the
// seam that lets this file's control flow (wait for the callback, or time out, exit
// exactly once either way) be exercised without a real process, a real pipe, or a real
// subprocess.
function fakeWriter(): { writer: StderrWriter; callbacks: (() => void)[] } {
  const callbacks: (() => void)[] = [];
  return {
    writer: {
      write(_chunk, callback) {
        callbacks.push(callback);
      },
    },
    callbacks,
  };
}

describe("exitAfterStderr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the message with a trailing newline", () => {
    const written: string[] = [];
    const writer: StderrWriter = {
      write(chunk, callback) {
        written.push(chunk);
        callback();
      },
    };
    const exit = vi.fn();

    exitAfterStderr("boom", 1, { writer, exit });

    expect(written).toEqual(["boom\n"]);
  });

  it("exits with the given code once the write's callback fires", () => {
    const { writer, callbacks } = fakeWriter();
    const exit = vi.fn();

    exitAfterStderr("boom", 1, { writer, exit });

    expect(exit).not.toHaveBeenCalled();
    callbacks[0]?.();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits via the safety timer if the write's callback never fires (e.g. a broken pipe)", () => {
    const { writer } = fakeWriter(); // callback captured but never invoked
    const exit = vi.fn();

    exitAfterStderr("boom", 1, { writer, exit, timeoutMs: 2000 });

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits exactly once even if both the callback and the timer fire", () => {
    const { writer, callbacks } = fakeWriter();
    const exit = vi.fn();

    exitAfterStderr("boom", 1, { writer, exit, timeoutMs: 2000 });

    callbacks[0]?.();
    vi.advanceTimersByTime(2000);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("does not exit again if the timer fires first and the write callback arrives late", () => {
    const { writer, callbacks } = fakeWriter();
    const exit = vi.fn();

    exitAfterStderr("boom", 1, { writer, exit, timeoutMs: 2000 });

    vi.advanceTimersByTime(2000);
    expect(exit).toHaveBeenCalledTimes(1);

    callbacks[0]?.();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  // Uses the real `setTimeout` (real timers, not the fake-timer clock the other cases
  // use) so the timer `exitAfterStderr` creates is a genuine `NodeJS.Timeout`, and asks
  // that real object whether it is still ref'd - a direct check of the property that
  // matters (can this timer, by itself, keep the process alive), not a mock standing in
  // for it. If a future edit dropped the `.unref()` call, `hasRef()` would report
  // `true` and this test would fail.
  it("the safety timer is unref'd, so it cannot itself hold the event loop open", () => {
    vi.useRealTimers();
    const { writer } = fakeWriter(); // callback never invoked; only the timer matters here
    const exit = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    let capturedTimer: NodeJS.Timeout | undefined;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout) => {
      capturedTimer = originalSetTimeout(handler, timeout);
      return capturedTimer;
    });

    exitAfterStderr("boom", 1, { writer, exit, timeoutMs: 60_000 });

    expect(capturedTimer?.hasRef()).toBe(false);

    setTimeoutSpy.mockRestore();
    clearTimeout(capturedTimer);
  });
});
