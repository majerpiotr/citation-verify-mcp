// src/resolver.ts
import { extractCitations, splitToken } from "./grammar.js";
import { interpretDocResult, type DocLookup } from "./pageindex-client.js";

export type CitationStatus = "resolved" | "unresolved" | "unchecked";

export interface CitationDetail {
  token: string;
  status: CitationStatus;
  title: string | null;
}

export interface VerifyResult {
  total: number;
  resolved: number;
  unresolved: string[];
  unchecked: string[];
  details: CitationDetail[];
}

export async function verifyCitations(text: string, client: DocLookup): Promise<VerifyResult> {
  const tokens = extractCitations(text);
  const details: CitationDetail[] = [];

  for (const token of tokens) {
    const { docName } = splitToken(token);
    let outcome: { found: boolean; title: string | null };
    try {
      // Both steps are inside the boundary: the lookup fails when the backend is
      // unreachable, and interpretDocResult throws when the payload states nothing about
      // the document. Either way the check could not be completed, so the verdict is
      // `unchecked` - never `unresolved` (CLAUDE.md hard rule 4).
      outcome = interpretDocResult(await client.getDocument(docName));
    } catch {
      details.push({ token, status: "unchecked", title: null });
      continue;
    }
    details.push({
      token,
      status: outcome.found ? "resolved" : "unresolved",
      title: outcome.title,
    });
  }

  return {
    total: tokens.length,
    resolved: details.filter((d) => d.status === "resolved").length,
    unresolved: details.filter((d) => d.status === "unresolved").map((d) => d.token),
    unchecked: details.filter((d) => d.status === "unchecked").map((d) => d.token),
    details,
  };
}
