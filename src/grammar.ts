// src/grammar.ts
const RE_NODE_ID = /node_id[:=]\s*([A-Za-z0-9_\-./#]+)/g;
const RE_DOC_PAGE = /([A-Za-z0-9_.\-]+)\.pdf[,;]?\s*(?:pp?\.|page)\s*(\d+(?:-\d+)?)/gi;

// Sentence/bracket punctuation that can trail a node_id token without being part of it.
function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:)\]}]+$/, "");
}

export function extractCitations(text: string): string[] {
  const matches: { index: number; token: string }[] = [];
  for (const m of text.matchAll(RE_NODE_ID)) {
    matches.push({ index: m.index ?? 0, token: stripTrailingPunctuation(m[1]) });
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
  const m = /^(.*)#p(\d+(?:-\d+)?)$/.exec(token);
  if (m) {
    return { docName: m[1], pages: m[2] };
  }
  return { docName: token, pages: null };
}
