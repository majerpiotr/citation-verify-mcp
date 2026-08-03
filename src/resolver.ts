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
  // The real file name of the cited document, and the ONE machine-readable answer to
  // "does the cited document exist?": non-null if and only if the backend positively
  // confirmed the document, whatever the status ends up being. So an `unresolved` with a
  // title is a REAL document cited with a wrong page or a wrong node (fix the citation,
  // keep the claim), while an `unresolved` with `title: null` names nothing that exists
  // (find the real source, or delete the claim). Those two demand opposite actions, and
  // before this field carried the difference it survived only in the English `suggestion`
  // text, which a consuming model has to read correctly.
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

// An identifier that resolves to no document (`docName: null`) is unverifiable by
// construction, and it reaches here from TWO shapes that grammar.ts deliberately reduces to
// the identical Citation - a bare `node_id:` with no document in the same sentence, and a
// bracket tag whose value names no document - so that an equivalent pair dedupes into one
// (src/grammar.ts, "Canonical token deliberately reuses the exact `node_id:<id>` prefix").
// This string is therefore read by a model for both, and must be true of both:
//
//   - `node_id: <id>` IS this grammar's reading of the backend's real per-document node
//     ordinal (docs/spike-b-findings.md section 6: small ordinals scoped inside one
//     document's tree - every document has a node "0000"), so naming the document in the
//     same sentence genuinely makes it checkable.
//   - A bracket tag is NOT that. Its value is a host-invented slug from a wholly different,
//     unconfirmed id space (docs/citation-grammar.md "Bracket-tag identifier": "its id space
//     has no defined relationship to the backend's per-document node ordinals"), and
//     grammar.ts never binds a tag to a document however the sentence is written. Telling
//     the model to name the document alongside it - as this string used to, flatly - is a
//     repair instruction that cannot work, handed over on the one status where the model is
//     told to delete nothing.
//
// Splitting the constant would need the two shapes to be distinguishable at this layer;
// they are not, by design, so the text names both cases instead of asserting one.
const UNBOUND_ID_SUGGESTION =
  "This citation names no document, so there was nothing to check it against - which is " +
  "not evidence that anything is missing. If it was written as `node_id: <id>`, that is a " +
  "per-document node ordinal: name the document in the same sentence to have the node " +
  "checked. If it came from a bracket tag (`[node: <id>]`), the id is never bound to any " +
  "document and its id space has no defined relationship to the backend's node numbering, " +
  "so no rewording of the tag can make it checkable - cite the document's real " +
  "`<name>.pdf` for a verdict.";

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

// The dominant production failure: the backend is unreachable, the credential was
// rejected, or the response could not be read. It used to return `suggestion: null`, which
// told a consuming agent nothing about why the citation was not checked - on the one path
// where that matters most, and while the README promises this field explains exactly that.
//
// STATIC on purpose, and this is the load-bearing part: a thrown error is UNTRUSTED text.
// A transport error can quote an `Authorization` header verbatim, and this string is
// handed straight to a model, so rendering the error here would risk putting a live
// credential into a model's context. The resolver deliberately does not know the API key
// (that would be the wrong module to hold it), so it could not redact one out even if it
// tried. Redaction can only happen where the secret is in scope - see logLookupFailure.
// A constant also keeps the field bounded, which a backend's error message is not.
// It does not change the verdict; the token stays `unchecked`.
const DOC_UNCHECKED_SUGGESTION =
  "This document could not be checked at all: the lookup failed (for example the corpus " +
  "was unreachable, the server's credential was rejected, or the response could not be " +
  "read). That is NOT evidence that the document is missing, so do not delete this " +
  "citation - leave it and check again later. The specific failure is written to the " +
  "server's stderr log rather than reported here.";

// Bound on one diagnostic line written to stderr. An MCP host captures this server's
// stderr into its log files, so a huge response body must not flood them.
const MAX_LOG_LINE_CHARS = 400;

// Renders untrusted text as a single printable line: control characters (which could forge
// a second log line or inject a terminal escape sequence) are collapsed to spaces, runs of
// whitespace collapse, and the result is length-capped. This is hygiene, NOT redaction -
// see logLookupFailure for where a secret can actually be removed.
function oneSafeLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_LOG_LINE_CHARS ? `${flat.slice(0, MAX_LOG_LINE_CHARS)}...` : flat;
}

// Only an error's name and message, never its stack (which can quote the message again)
// and never its enumerable properties (a transport error can carry the whole requestInit,
// headers included). `String(value)` on a non-Error renders "[object Object]" rather than
// walking it, for the same reason.
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // A specific name (TypeError, AbortError) is diagnostic and is kept; the generic "Error"
  // is not, and the client already renders a cause chain into the message, so keeping it
  // would print "Error: Error: ..." for every ordinary failure.
  return err.name === "Error" ? err.message : `${err.name}: ${err.message}`;
}

// Writes ONE line to stderr for a lookup that could not run. Without it, an outage, a
// credential pointing at the wrong account and a backend schema change are indistinguishable
// to whoever is holding the pager: all three produce a sweep of `unchecked` verdicts and a
// silent log, and every diagnostic src/pageindex-client.ts builds is unobservable.
//
// stderr, never stdout - stdout carries the MCP protocol stream (test/stdout-safety.test.ts).
//
// On secrets: this prints a thrown message, and the resolver cannot redact a key it does
// not hold. The guarantee comes from the layer that DOES hold it - PageindexHttpClient
// scrubs the key out of every error it throws, at the one place the key is in scope (see
// `connect`), so nothing crossing the DocLookup boundary carries it. That is a contract on
// DocLookup, stated on the interface. What this function adds is the hygiene above:
// bounded, single-line, control-character-free, for text that came from a draft an agent
// wrote and a response a backend sent.
function logLookupFailure(what: string, docName: string, err: unknown): void {
  console.error(
    oneSafeLine(`citation-verify-mcp: ${what} for "${docName}" could not be checked: ${errorText(err)}`),
  );
}

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
    return { token, status: "unchecked", title: null, suggestion: UNBOUND_ID_SUGGESTION };
  }

  // Step 2: does the document exist at all? A throw, or anything the client could not turn
  // into a definite found/not-found, is `unchecked`. `found: false` is a positive miss -
  // `unresolved` - and nothing about page or node can be checked without a real document, so
  // this returns immediately.
  const docOutcome = await getDocOutcome(docName, client, docOutcomes);
  if (docOutcome.kind === "unchecked") {
    // `title` stays null: nothing was confirmed about this document, not even that it
    // exists. The explanation is static - see DOC_UNCHECKED_SUGGESTION.
    return { token, status: "unchecked", title: null, suggestion: DOC_UNCHECKED_SUGGESTION };
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
  //
  // `title` is the document's REAL name here, because the document really was found: this
  // is the citation a consuming agent must FIX (wrong page, wrong node) rather than delete,
  // and reporting `title: null` on it made it byte-identical to a citation naming a
  // document that does not exist - the opposite action.
  if (pageFailed || nodeFailed) {
    return { token, status: "unresolved", title: doc.name, suggestion };
  }

  // Neither half positively failed, but the node check could not run - `unchecked`, per the
  // same reasoning as step 2: an incomplete check must never present as a clean pass.
  // `title` is set for the same reason as above: the DOCUMENT was positively confirmed,
  // only its outline could not be read.
  if (nodeUnchecked) {
    return { token, status: "unchecked", title: doc.name, suggestion };
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
  } catch (err) {
    // The client's contract: a throw means the check could not run. Never reinterpreted as
    // a positive miss. The error is not discarded: it is the only signal an operator gets
    // for the most common production failure, so it goes to stderr - once per distinct
    // document name, since this whole function is memoized per call.
    logLookupFailure("document", docName, err);
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
  } catch (err) {
    // Recorded as a throw, never as "node absent" - and reported to the operator, for the
    // same reason as the document path above. Once per distinct document name.
    logLookupFailure("document structure", docName, err);
    ids = null;
  }
  cache.set(docName, ids);
  return ids;
}
