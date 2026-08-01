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
// pipe - so a stuck write cannot turn this back into the hang it exists to avoid.

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

export interface ExitAfterStderrOptions {
  // Milliseconds to wait for the write's callback before exiting anyway. Defaults to a
  // couple of seconds - long enough for a normal flush, short enough that a broken pipe
  // doesn't hang the process noticeably.
  timeoutMs?: number;
  writer?: StderrWriter;
  exit?: (code: number) => void;
}

/**
 * Writes `message` (plus a trailing newline) to stderr, then exits with `code` once the
 * write's callback fires or the safety timer elapses, whichever happens first. Exits
 * exactly once even if both fire.
 */
export function exitAfterStderr(message: string, code: number, options: ExitAfterStderrOptions = {}): void {
  const { timeoutMs = 2000, writer = realStderrWriter, exit = process.exit } = options;

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
