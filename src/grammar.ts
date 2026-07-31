// src/grammar.ts
// Single source of truth for the page-number shape. Extraction and splitToken must agree:
// if only one of them learned a new shape, splitToken would silently stop splitting and
// the whole token would be sent to the backend as a document name.
const PAGE_NUMBER = String.raw`\d+(?:-\d+)?`;

const RE_NODE_ID = /node_id[:=]\s*([A-Za-z0-9_\-./#]+)/g;
const RE_DOC_PAGE = new RegExp(
  String.raw`([A-Za-z0-9_.\-]+)\.pdf[,;]?\s*(?:pp?\.|page)\s*(${PAGE_NUMBER})`,
  "gi",
);
const RE_PAGE_SUFFIX = new RegExp(String.raw`^(.*)#p(${PAGE_NUMBER})$`);

// Sentence/bracket punctuation that can trail a node_id token without being part of it.
function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:)\]}]+$/, "");
}

export function extractCitations(text: string): string[] {
  const matches: { index: number; token: string }[] = [];
  for (const m of text.matchAll(RE_NODE_ID)) {
    const token = stripTrailingPunctuation(m[1]);
    // Nothing left after stripping (e.g. "node_id: ..."): not a citation. An empty token
    // would be sent to the backend as an empty docName and would inflate `total`.
    if (!token) continue;
    matches.push({ index: m.index ?? 0, token });
  }
  for (const m of text.matchAll(RE_DOC_PAGE)) {
    matches.push({ index: m.index ?? 0, token: `${m[1]}.pdf#p${m[2]}` });
  }
  matches.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  for (const m of matches) seen.add(m.token);
  return [...seen];
}

export function splitToken(token: string): { docName: string; pages: string | null } {
  const m = RE_PAGE_SUFFIX.exec(token);
  if (m) {
    return { docName: m[1], pages: m[2] };
  }
  return { docName: token, pages: null };
}
