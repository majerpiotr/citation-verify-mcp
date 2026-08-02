// src/exit-after-stderr.ts
// Startup-failure exit for src/index.ts's two catch sites. By the time either can fire,
// a `PageindexHttpClient` transport may already be connected, and an open HTTP
// transport can keep the event loop alive - so `console.error` + `process.exitCode = 1`
// (safe in index.ts's missing-key branch, where nothing has been constructed yet) can
// mean "hang forever, serving nothing" here instead of exiting. A bare
// `process.exit(code)` right after a stderr write avoids the hang but risks truncating
// that write, since stderr is a pipe under an MCP host and pipe writes to a pipe are
// asynchronous - the same problem `process.exitCode` works around elsewhere in this
// file. `exitAfterStderr` is the only form that gets both: it waits for the write to
// flush (proven by the write's own completion callback) before exiting, and it exits
// anyway after a short, `unref`'d timeout if that callback never fires - e.g. a broken
// pipe - so a stuck write cannot turn this back into the hang it exists to avoid. It
// also sets `process.exitCode` as a floor up front, so that even the one path where
// neither the callback nor the timer can run (a swallowed callback with nothing else
// keeping the loop alive) exits non-zero rather than reporting a clean success.

// The write side is injected (`writer`) rather than calling `process.stderr.write`
// directly, matching this codebase's existing pattern of injecting the true I/O seam
// (see `accumulateNodeIds`'s `fetchPart` in pageindex-client.ts) so the control flow -
// wait for the callback, or time out, exit exactly once either way - is unit-testable
// without touching the real process, a real pipe, or a real subprocess.
export interface StderrWriter {
  write(chunk: string, callback: () => void): void;
}

const realStderrWriter: StderrWriter = {
  write(chunk, callback) {
    process.stderr.write(chunk, callback);
  },
};

// Records the failure in `process.exitCode` without exiting. Injected like the writer
// and the exit, so a unit test can observe the floor being set without touching the
// test runner's own exit code.
const realExitCodeSink = (code: number): void => {
  process.exitCode = code;
};

export interface ExitAfterStderrOptions {
  // Milliseconds to wait for the write's callback before exiting anyway. Defaults to a
  // couple of seconds - long enough for a normal flush, short enough that a broken pipe
  // doesn't hang the process noticeably.
  timeoutMs?: number;
  writer?: StderrWriter;
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
}

/**
 * Writes `message` (plus a trailing newline) to stderr, then exits with `code` once the
 * write's callback fires or the safety timer elapses, whichever happens first. Exits
 * exactly once even if both fire.
 */
export function exitAfterStderr(message: string, code: number, options: ExitAfterStderrOptions = {}): void {
  const {
    timeoutMs = 2000,
    writer = realStderrWriter,
    exit = process.exit,
    setExitCode = realExitCodeSink,
  } = options;

  // Failure floor, set before anything else can go wrong. Both normal paths below exit
  // explicitly with `code`, so this changes nothing about them - it only covers the one
  // path neither of them reaches: if the write's callback is swallowed AND nothing refs
  // the event loop, the `unref`'d timer cannot keep the process alive, the loop drains,
  // and Node exits on its own with whatever `process.exitCode` holds. Without this line
  // that is 0 - a startup failure reported to the MCP host as a clean success. It costs
  // nothing and touches neither the flush-before-exit nor the never-hang property.
  setExitCode(code);

  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  // `unref`'d: this timer exists only to force an exit if the write never completes -
  // it must never be a reason, by itself, for the process to stay alive.
  const timer = setTimeout(exitOnce, timeoutMs);
  timer.unref();

  writer.write(`${message}\n`, exitOnce);
}
