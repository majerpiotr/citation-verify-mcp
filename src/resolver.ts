// src/resolver.ts
//
// Classifies each citation extracted from a draft against the real corpus, per
// docs/rework-plan.md Task R3. The load-bearing invariant (CLAUDE.md hard rule 4):
// `unresolved` requires a POSITIVE miss - a document confirmed absent, a page confirmed
// outside the real page count, or a node confirmed absent from the real tree.
// `unchecked` is everything the check could not run to completion: a bare node id with no
// document, or any throw from the client. A throw is NEVER caught and turned into anything
// but `unchecked` - that is the client's contract (docs/rework-plan.md "Target interfaces").
import { extractCitations, type Citation } from "./grammar.js";
import type { DocLookup, DocumentInfo } from "./pageindex-client.js";

export type CitationStatus = "resolved" | "unresolved" | "unchecked";

export interface CitationDetail {
  token: string;
  status: CitationStatus;
  title: string | null;
  suggestion: string | null; // e.g. a near-miss document name, or the real page count
}

export interface VerifyResult {
  total: number;
  resolved: number;
  unresolved: string[];
  unchecked: string[];
  details: CitationDetail[];
}

// A bare `node_id:` with no document in the same sentence is unverifiable by construction
// (docs/spike-b-findings.md section 6: node ids are small ordinals scoped inside one
// document's tree, not a corpus-wide identifier - every document has a node "0000"). This
// is stated up front so a consuming agent knows to fix the citation, not retry it.
const BARE_NODE_SUGGESTION =
  "A node id alone cannot be verified: node ids are scoped to a single document's own " +
  "numbering, so this citation must also name the document it belongs to.";

// The backend's own near-name hint (`similar_files`) fires when the extension is missing or
// its case is wrong, but comes back EMPTY when the case of the name's stem differs
// (docs/spike-b-findings.md section 4). That silent case is the most likely real-world
// mistake, and it used to produce a bare `unresolved` with no explanation at all - which a
// consuming agent acts on by deleting a claim that may name a document that genuinely exists
// under a different capitalisation. This is a STATIC string on purpose: it names no document
// and quotes no fragment of one, because refusing to guess which document was meant is this
// server's whole premise. It does not change the verdict; the token stays `unresolved`.
// Exported so the README's worked example, which quotes this string verbatim, can be pinned
// to it by a test instead of carrying its own copy (test/server.test.ts).
export const NO_NEAR_MATCH_SUGGESTION =
  "No document with this exact name exists in the corpus, and no near match was offered. " +
  "Names are matched case-sensitively and the file extension is part of the name, so a name " +
  "differing only in capitalisation misses silently, with no hint. Look up the document's " +
  "actual file name in the corpus before removing or rewriting this citation; do not guess " +
  "at alternative capitalisations.";

const PAGE_COUNT_UNKNOWN_SUGGESTION =
  "The document's page count is not available, so the cited page could not be verified.";

const NODE_UNCHECKED_SUGGESTION =
  "The cited node could not be verified because the document's structure could not be checked.";

function pageOutOfRangeSuggestion(pageCount: number): string {
  return `This document has ${pageCount} page${pageCount === 1 ? "" : "s"}; the cited page is outside that range.`;
}

function nodeAbsentSuggestion(nodeId: string): string {
  return `Node "${nodeId}" was not found in this document's structure.`;
}

// Outcome of resolving a document name, memoized per call (see the per-call maps in
// verifyCitations). `unchecked` collapses both a thrown lookup and a positively-checked
// success/not-found shape mismatch - the client's `interpretGetDocument` already throws on
// anything ambiguous, so by the time it reaches here there is nothing left to disambiguate.
type DocOutcome =
  | { kind: "found"; doc: DocumentInfo }
  | { kind: "not-found"; suggestion: string | null }
  | { kind: "unchecked" };

export async function verifyCitations(text: string, client: DocLookup): Promise<VerifyResult> {
  const citations = extractCitations(text);
  const details: CitationDetail[] = [];

  // Per-call memoization ONLY. Both maps are created fresh for this call and discarded when
  // it returns - never a cache across calls (CLAUDE.md hard rule 3). A distinct docName is
  // looked up at most once here; a document's node ids are fetched at most once here.
  const docOutcomes = new Map<string, DocOutcome>();
  const nodeIdSets = new Map<string, Set<string> | null>(); // null records a lookup that threw

  // Sequential by design (v0 scope: no Promise.all, no parallelism) - a shared docName must
  // see its own already-resolved outcome before the next citation starts its own lookup.
  for (const citation of citations) {
    details.push(await classify(citation, client, docOutcomes, nodeIdSets));
  }

  return {
    total: citations.length,
    resolved: details.filter((d) => d.status === "resolved").length,
    unresolved: details.filter((d) => d.status === "unresolved").map((d) => d.token),
    unchecked: details.filter((d) => d.status === "unchecked").map((d) => d.token),
    details,
  };
}

async function classify(
  citation: Citation,
  client: DocLookup,
  docOutcomes: Map<string, DocOutcome>,
  nodeIdSets: Map<string, Set<string> | null>,
): Promise<CitationDetail> {
  const { token, docName, pages, nodeId } = citation;

  // Step 1: a bare node id with no document is unverifiable by construction. The backend is
  // never touched for it.
  if (docName === null) {
    return { token, status: "unchecked", title: null, suggestion: BARE_NODE_SUGGESTION };
  }

  // Step 2: does the document exist at all? A throw, or anything the client could not turn
  // into a definite found/not-found, is `unchecked`. `found: false` is a positive miss -
  // `unresolved` - and nothing about page or node can be checked without a real document, so
  // this returns immediately.
  const docOutcome = await getDocOutcome(docName, client, docOutcomes);
  if (docOutcome.kind === "unchecked") {
    return { token, status: "unchecked", title: null, suggestion: null };
  }
  if (docOutcome.kind === "not-found") {
    return { token, status: "unresolved", title: null, suggestion: docOutcome.suggestion };
  }
  const { doc } = docOutcome;

  // Every note accumulated below - failure messages AND "this half was not verified"
  // notes alike - is carried into the final suggestion regardless of which status it ends
  // up producing. `unresolved` deletes the whole citation, so its suggestion is the only
  // channel left to say "and the other half was never checked either"; dropping a note
  // just because the OTHER half is what decided the status would silently misinform the
  // consuming agent about what was actually verified.
  const notes: string[] = [];

  // Step 3: page bounds, only checked when the real page count is known. An unknown page
  // count does not fail the citation on its own - the document/node verdict stands - but a
  // note is still recorded so a consuming agent is never misled into thinking the page was
  // verified. Both endpoints of the cited range are bounds-checked, not just the second
  // number written: the grammar puts no ordering constraint on "pp.<N>-<M>", so a
  // descending range (e.g. "pp.99-3") is real input, and comparing only the second number
  // would let a fabricated page slip through as a clean `resolved`.
  let pageFailed = false;
  if (pages) {
    if (doc.pageCount === null) {
      notes.push(PAGE_COUNT_UNKNOWN_SUGGESTION);
    } else {
      const lo = Math.min(pages.from, pages.to);
      const hi = Math.max(pages.from, pages.to);
      if (lo < 1 || hi > doc.pageCount) {
        pageFailed = true;
        notes.push(pageOutOfRangeSuggestion(doc.pageCount));
      }
    }
  }

  // Step 4: node membership, only checked when a node was actually cited - never
  // speculatively. This always runs when nodeId is set, independent of the page result
  // above, so a combined page+node citation can report which half failed (or that both
  // did, or that one failed while the other could not even be checked).
  let nodeFailed = false;
  let nodeUnchecked = false;
  if (nodeId !== null) {
    const ids = await getNodeIdSet(docName, client, nodeIdSets);
    if (ids === null) {
      nodeUnchecked = true;
      notes.push(NODE_UNCHECKED_SUGGESTION);
    } else if (!ids.has(nodeId)) {
      nodeFailed = true;
      notes.push(nodeAbsentSuggestion(nodeId));
    }
  }

  const suggestion = notes.length > 0 ? notes.join(" ") : null;

  // A positively-confirmed miss on either half makes the whole citation `unresolved`, even
  // when the OTHER half could not be checked at all (e.g. the page is provably out of
  // range while the node lookup separately throws): the miss was established against real
  // data and stays true regardless of what the other half would have said. Falling back to
  // `unchecked` there would let a degraded outline service launder a fabricated page number
  // into "keep this" - adjudicated, see the R3 review.
  if (pageFailed || nodeFailed) {
    return { token, status: "unresolved", title: null, suggestion };
  }

  // Neither half positively failed, but the node check could not run - `unchecked`, per the
  // same reasoning as step 2: an incomplete check must never present as a clean pass.
  if (nodeUnchecked) {
    return { token, status: "unchecked", title: null, suggestion };
  }

  // Step 5: resolved. `suggestion` here (if set) is only the "page count unknown, not
  // checked" note - carried through so a resolved verdict does not imply the page itself was
  // verified.
  return { token, status: "resolved", title: doc.name, suggestion };
}

async function getDocOutcome(
  docName: string,
  client: DocLookup,
  cache: Map<string, DocOutcome>,
): Promise<DocOutcome> {
  const cached = cache.get(docName);
  if (cached) return cached;

  let outcome: DocOutcome;
  try {
    const result = await client.getDocument(docName);
    outcome = result.found
      ? { kind: "found", doc: result.doc }
      : {
          kind: "not-found",
          // A real near match from the backend is strictly better information than the
          // generic hint, so it wins whenever one was offered.
          suggestion: result.similar[0]
            ? `Did you mean "${result.similar[0]}"?`
            : NO_NEAR_MATCH_SUGGESTION,
        };
  } catch {
    // The client's contract: a throw means the check could not run. Never reinterpreted as
    // a positive miss.
    outcome = { kind: "unchecked" };
  }
  cache.set(docName, outcome);
  return outcome;
}

async function getNodeIdSet(
  docName: string,
  client: DocLookup,
  cache: Map<string, Set<string> | null>,
): Promise<Set<string> | null> {
  if (cache.has(docName)) return cache.get(docName) ?? null;

  let ids: Set<string> | null;
  try {
    ids = await client.getNodeIds(docName);
  } catch {
    ids = null; // records a throw without ever treating it as "node absent"
  }
  cache.set(docName, ids);
  return ids;
}
