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

  // One backend round trip per distinct document within THIS call. Several tokens can
  // cite different pages of the same document, and each lookup carries the SDK's default
  // per-request timeout, so per-token lookups can outlast the host's own tool-call budget
  // and leave the agent with no verdict at all. `null` records a lookup that failed.
  // Not a cache: this map is created per call and dies with it.
  const outcomes = new Map<string, { found: boolean; title: string | null } | null>();

  for (const token of tokens) {
    const { docName } = splitToken(token);

    if (!outcomes.has(docName)) {
      try {
        // Both steps are inside the boundary: the lookup fails when the backend is
        // unreachable, and interpretDocResult throws when the payload states nothing about
        // the document. Either way the check could not be completed, so the verdict is
        // `unchecked` - never `unresolved` (CLAUDE.md hard rule 4).
        outcomes.set(docName, interpretDocResult(await client.getDocument(docName)));
      } catch {
        outcomes.set(docName, null);
      }
    }

    const outcome = outcomes.get(docName) ?? null;
    if (outcome === null) {
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
