// src/api-key.ts
// Pure predicate: is this value plausibly a real PageIndex API key, as opposed to a
// missing value, whitespace, an unsubstituted shell placeholder, or a doc-style
// placeholder string? Deliberately does not validate key format - PageIndex's format
// is unknown, and guessing at it would risk rejecting valid keys.
//
// Also holds the redaction helper (below) used to keep a live key out of stderr if a
// third-party error message ever quotes it verbatim - grouped here because both guard
// the same secret at its two exposure points: before it is used, and if something
// downstream fails after it was used.

/**
 * True if `raw` is usable AS GIVEN: present, non-blank, carrying no surrounding
 * whitespace and no control character (so it is legal to interpolate verbatim into an
 * `Authorization` header value), and not a recognizable placeholder. Pure - no I/O, no
 * process access.
 *
 * The verdict is about the argument itself, never about a normalized copy of it. That
 * matters because the natural caller pattern is `if (isUsableApiKey(raw)) connect(raw)`:
 * a predicate that answered `true` for a value whose *trimmed* form is fine would hand
 * the untrimmed original to a header builder, which is exactly the leak path this guard
 * exists to close. A caller reading from an environment variable or a file should trim
 * at the read site (as src/index.ts does) and ask about the trimmed value.
 */
export function isUsableApiKey(raw: string | undefined): boolean {
  if (raw === undefined) return false;

  const trimmed = raw.trim();
  if (trimmed === "") return false;
  // Surrounding whitespace is not illegal in a header value, but it is silently
  // stripped there, so what would be sent differs from what was passed in - and a value
  // that only becomes correct after normalization is not usable as given.
  if (trimmed !== raw) return false;

  // Unsubstituted shell placeholder, e.g. "${PAGEINDEX_API_KEY}" (docs/design.md's own
  // example config).
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) return false;

  // Angle-bracket-wrapped documentation placeholder - the shape README.md's own
  // `mcpServers` blocks ship ("<your-pageindex-api-key>"). Judged on the WRAPPER, not on
  // what is inside it, because the wrapper is the reliable part: no real credential is
  // ever delivered enclosed in angle brackets, while what a doc writer puts between them
  // is unbounded ("<paste your key here>", "<key>", a translated phrase). Angle brackets
  // are legal in a header value, so without this the README's own placeholder was sent to
  // the network and came back as "Could not validate credentials" - a message about a
  // wrong key, for what is actually an unfilled one, on the most likely first-run
  // mistake. Only the wrapper is inspected; the value is never echoed anywhere.
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return false;

  const lower = trimmed.toLowerCase();

  // "replace-with..." style placeholder.
  if (lower.startsWith("replace-with")) return false;

  // "your-api-key" style placeholder, any separator (hyphen, underscore, none), with an
  // optional product word between "your" and "api" ("your-pageindex-api-key"). Anchored
  // at both ends and the infix is letters only, so this recognizes a value that is
  // NOTHING but the placeholder phrase - a real key that happens to contain those words
  // ("pi-your-api-key-9f2c...") is still accepted.
  const collapsed = lower.replace(/[-_\s]/g, "");
  if (/^your[a-z]*apikey$/.test(collapsed)) return false;

  // A control character (C0 range or DEL) anywhere in the value. This is not a guess at
  // the key's format: no control character can legally occupy an HTTP header value, so a
  // key carrying one (a `\n` from a wrapped paste, a two-line key.txt, a `\r` from a
  // Windows-authored file) would otherwise reach `Authorization: Bearer ...` and throw
  // out of the SDK's Headers construction with the key quoted in the error message.
  // Rejecting here keeps that value from ever being used, before it can reach a header
  // or a log line. Tested against `raw`, like every other check above.
  if (/[\x00-\x1f\x7f]/.test(raw)) return false;

  return true;
}

// Replaces every occurrence of `secret` in `text` with a fixed marker. Pure, and a
// no-op (returns `text` unchanged) when `secret` does not appear in it or is empty -
// safe to call unconditionally on text that may or may not carry the secret.
export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("***");
}

// Bound on the rendered failure, in characters. An MCP host captures a stdio server's
// stderr into its log files, and the text below is BACKEND-CONTROLLED (see the flattening
// note), so a large response body must not flood them. Deliberately the same 400 as
// `MAX_LOG_LINE_CHARS` in src/resolver.ts and `MAX_ERROR_CHARS` in src/pageindex-client.ts:
// with equal budgets the client's own cap over this output is exactly idempotent (it
// re-slices to the same 400 characters and re-appends the same marker) rather than a
// double-truncation that would eat into the marker.
const MAX_RENDERED_FAILURE_CHARS = 400;

// Collapses untrusted text to a single printable line: control characters (which could
// forge a second log line or inject a terminal escape sequence) become spaces, runs of
// whitespace collapse, and the ends are trimmed. Hygiene, NOT redaction - `redactSecret` is
// the only thing that removes a secret.
//
// This is a deliberate second copy of the routine src/resolver.ts keeps privately for its
// own stderr line, not an import: exporting the resolver's copy would make this module -
// which pageindex-client.ts depends on - depend on the resolver, inverting the layering, and
// a shared module for four lines that only two callers want was judged the larger change of
// the two. The duplication is bounded and both copies are pinned by tests; if a third caller
// ever needs it, that is the point to move it into one module both can import.
function flattenToOneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

// How many `cause` levels are rendered below the top-level error. Deep enough for
// undici's real chains (fetch failed -> connect error -> TLS error), shallow enough that
// a pathological chain cannot flood stderr.
const MAX_CAUSE_DEPTH = 4;

// Renders exactly one link of a cause chain: an error's `name` and redacted `message`,
// or a redacted string rendering of a non-Error value. `String(value)` is deliberate -
// it never walks an object's properties, so a non-Error cause carrying the key in some
// field renders as "[object Object]" rather than exposing it.
function describeOneLevel(value: unknown, secret: string): string {
  const [name, message] = value instanceof Error ? [value.name, value.message] : ["Error", String(value)];
  return `${name}: ${redactSecret(message, secret)}`;
}

/**
 * Renders a caught error for stderr with `secret` scrubbed out of it. Used at the
 * top-level startup catch so that a third-party error which happens to embed a live
 * credential (e.g. undici's Headers construction quoting an invalid header value
 * verbatim) cannot leak it into an MCP host's captured log files.
 *
 * Only each level's `name` and redacted `message` are read - never the raw error object
 * and never a stack, either of which could carry the secret through some property this
 * function doesn't know to scrub. The `cause` chain IS followed, because undici puts the
 * entire actionable signal there (a wrong host, a refused connection, a self-signed
 * certificate all surface as the same "TypeError: fetch failed" at the top level);
 * dropping it would leave an operator with nothing to act on. Every level goes through
 * the same redaction, so following the chain adds no exposure.
 *
 * A cyclic chain (a self-referential `cause`, or two errors pointing at each other) and
 * an absurdly deep one both terminate with a marker instead of looping or flooding.
 * `secret` is always the caller's own in-scope value, threaded straight from a local
 * variable; this function holds no state.
 *
 * The result is also ONE line and length-capped, because redaction alone was not enough
 * here. The text is not merely third-party, it is BACKEND-CONTROLLED: the SDK's
 * `StreamableHTTPClientTransport` throws `Error POSTing to endpoint: ${raw response body}`
 * from inside `client.connect`, and src/index.ts hands what this returns straight to
 * `exitAfterStderr`. A review reproduced one startup failure rendering 250 KB across three
 * stderr lines - CR/LF, an `ESC[2J`, and a forged copy of the resolver's own log-line
 * format - into the files an MCP host captures. That is availability and log forging, not a
 * wrong verdict, but it is free to close: same hygiene as `logLookupFailure` in
 * src/resolver.ts, on the one other path that prints untrusted text.
 */
export function describeStartupFailure(err: unknown, secret: string): string {
  const levels: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; ; depth++) {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        levels.push("[circular cause]");
        break;
      }
      seen.add(current);
    }
    levels.push(describeOneLevel(current, secret));

    if (!(current instanceof Error) || current.cause === undefined) break;
    if (depth >= MAX_CAUSE_DEPTH) {
      levels.push("[cause chain truncated]");
      break;
    }
    current = current.cause;
  }

  // Hygiene runs LAST, over the joined rendering, and never in place of the per-level
  // redaction above - that pass is the one that matches the key as given, and it must see
  // the message untouched.
  //
  // Redaction then runs a SECOND time, on the flattened text. Flattening rewrites the
  // string, and a rewrite after redaction can reassemble the secret out of a form the
  // first pass could not match: a key with an interior space is legal in a header value
  // and accepted by `isUsableApiKey`, so a message quoting it with a tab or a newline
  // where the space belongs becomes the literal key the moment whitespace collapses. The
  // second pass costs one scan of a bounded string and closes that.
  //
  // The cap comes after both, never before: truncating an unredacted string can cut the
  // secret in half, and `redactSecret` matches the whole value, so the surviving prefix
  // would then pass through untouched - half a credential printed to a log is still a leak.
  const flat = redactSecret(flattenToOneLine(levels.join(" <- caused by ")), secret);
  return flat.length > MAX_RENDERED_FAILURE_CHARS ? `${flat.slice(0, MAX_RENDERED_FAILURE_CHARS)}...` : flat;
}
