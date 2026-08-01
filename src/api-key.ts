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
 * True if `raw` looks like a usable API key: present, non-blank once trimmed, and not
 * a recognizable placeholder. Pure - no I/O, no process access.
 */
export function isUsableApiKey(raw: string | undefined): boolean {
  if (raw === undefined) return false;

  const trimmed = raw.trim();
  if (trimmed === "") return false;

  // Unsubstituted shell placeholder, e.g. "${PAGEINDEX_API_KEY}" (docs/design.md's own
  // example config).
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) return false;

  const lower = trimmed.toLowerCase();

  // "replace-with..." style placeholder.
  if (lower.startsWith("replace-with")) return false;

  // "your-api-key" style placeholder, any separator (hyphen, underscore, none).
  const collapsed = lower.replace(/[-_\s]/g, "");
  if (collapsed === "yourapikey") return false;

  // A control character (C0 range or DEL) embedded anywhere in the value - not just at
  // the ends, which `.trim()` already removed above. This is not a guess at the key's
  // format: no control character can legally occupy an HTTP header value, so a key
  // carrying one (a `\n` from a wrapped paste, a two-line key.txt, a `\r` from a
  // Windows-authored file) would otherwise reach `Authorization: Bearer ...` and throw
  // out of the SDK's Headers construction with the key quoted in the error message.
  // Rejecting here keeps that value from ever being used, before it can reach a header
  // or a log line.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;

  return true;
}

// Replaces every occurrence of `secret` in `text` with a fixed marker. Pure, and a
// no-op (returns `text` unchanged) when `secret` does not appear in it or is empty -
// safe to call unconditionally on text that may or may not carry the secret.
export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("***");
}

/**
 * Renders a caught error for stderr with `secret` scrubbed out of its message. Used at
 * the top-level startup catch so that a third-party error which happens to embed a live
 * credential (e.g. undici's Headers construction quoting an invalid header value
 * verbatim) cannot leak it into an MCP host's captured log files. Only the error's
 * `name` and a redacted `message` are read out of it - never the raw error object,
 * never a stack - either of which could carry the secret through some other property
 * this function doesn't know to scrub. `secret` is always the caller's own in-scope
 * value, threaded straight from a local variable; this function holds no state.
 */
export function describeStartupFailure(err: unknown, secret: string): string {
  const [name, message] = err instanceof Error ? [err.name, err.message] : ["Error", String(err)];
  return `${name}: ${redactSecret(message, secret)}`;
}
