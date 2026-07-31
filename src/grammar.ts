// src/grammar.ts
const RE_NODE_ID = /node_id[:=]\s*([A-Za-z0-9_\-./#]+)/g;
const RE_DOC_PAGE = /([A-Za-z0-9_\-]+)\.pdf\s*(?:p\.|page\s+)(\d+(?:-\d+)?)/gi;

export function extractCitations(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(RE_NODE_ID)) seen.add(m[1]);
  for (const m of text.matchAll(RE_DOC_PAGE)) seen.add(`${m[1]}.pdf#p${m[2]}`);
  return [...seen];
}

export function splitToken(token: string): { docName: string; pages: string | null } {
  if (token.includes("#p")) {
    const idx = token.indexOf("#p");
    return { docName: token.slice(0, idx), pages: token.slice(idx + 2) };
  }
  return { docName: token, pages: null };
}
