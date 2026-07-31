// src/api-key.ts
// Pure predicate: is this value plausibly a real PageIndex API key, as opposed to a
// missing value, whitespace, an unsubstituted shell placeholder, or a doc-style
// placeholder string? Deliberately does not validate key format - PageIndex's format
// is unknown, and guessing at it would risk rejecting valid keys.

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

  return true;
}
