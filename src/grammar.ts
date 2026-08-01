// src/grammar.ts
//
// A citation names a DOCUMENT, optionally narrowed by a page or a node - the citation
// model approved in docs/rework-plan.md ("Target citation model"), which supersedes the
// earlier assumption that a bare node_id identifies a document. It does not: per
// docs/spike-b-findings.md section 6, node_id values are small ordinals scoped inside one
// document's tree, and every document has a node "0000". A bare node_id with no document
// in the same sentence is therefore unverifiable by construction and is emitted with
// docName: null so the resolver reports it `unchecked`, never `unresolved` (CLAUDE.md hard
// rule 4) - never guessed at as a document name.

export interface Citation {
  token: string; // canonical, agent-facing
  docName: string | null; // null => unverifiable without a document
  pages: { from: number; to: number } | null;
  nodeId: string | null;
}

// Builds a case-insensitive-but-verbatim-preserving regex fragment from a literal string,
// e.g. ci("p.") -> "[pP]\.". Used only for the page/node KEYWORDS (p., pp., page, pages,
// node_id). The document name and its .pdf extension are matched and captured
// case-SENSITIVELY and verbatim - the backend looks documents up by exact file name
// (docs/spike-b-findings.md section 4), so normalizing case would turn a valid citation
// into a false `unresolved`.
function ci(literal: string): string {
  return [...literal]
    .map((ch) =>
      /[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
}

// A document name may itself contain dots (annual.report.pdf). This class is greedy and
// the trailing literal \.pdf forces the engine to backtrack to the LAST ".pdf" in the
// run, so it always captures the longest valid name rather than truncating at the first
// dot. Space is deliberately excluded from the class, so a name can never span a word
// boundary into neighbouring prose.
const DOC_NAME_PATTERN = String.raw`[A-Za-z0-9_.\-]+\.pdf`;

const PAGE_KEYWORD = `(?:${ci("pp.")}|${ci("pages")}|${ci("page")}|${ci("p.")})`;
const NODE_ID_KEYWORD = ci("node_id");

// Every bare document mention. Used both to emit doc-only citations and as the set of
// anchors a node id can bind to (see the binding pass below).
const RE_DOC = new RegExp(DOC_NAME_PATTERN, "g");

// A document immediately followed by a page marker, with nothing but an optional , or ;
// and whitespace between them - no other words. Judgment call (docs/rework-plan.md Task
// R2 leaves the exact proximity open): a page reference in a real draft is almost always
// glued to the name it narrows ("report.pdf p.5"), so requiring adjacency avoids
// accidentally pairing a page number with a document mentioned earlier in the same
// sentence but not the one the page actually refers to.
const RE_DOC_PAGE = new RegExp(String.raw`(${DOC_NAME_PATTERN})[,;]?\s*${PAGE_KEYWORD}\s*(\d+)(?:-(\d+))?`, "g");

// node_id: <id> or node_id=<id>. The id charset intentionally includes characters (like
// ".") that can also be sentence punctuation; stripTrailingPunctuation below cleans up
// after a greedy match runs into a sentence boundary.
const RE_NODE_ID = new RegExp(String.raw`${NODE_ID_KEYWORD}[:=]\s*([A-Za-z0-9_\-./]+)`, "g");

// Sentence boundary, the concrete definition "same sentence" is built on: a run of .!?
// followed by whitespace and then a CAPITAL letter, or followed by end of string; a run
// of newlines always counts too (paragraph breaks bind nothing across them). Requiring a
// capital letter after the punctuation is what lets this ignore the page abbreviation
// "p." (or "pp.") sitting mid-sentence right before a page NUMBER: a digit is never an
// uppercase letter, so "report.pdf p. 5, node_id: 0003" is never mistaken for two
// sentences. Known, accepted limitation: a genuine new sentence that starts with a
// lowercase word or a digit will not be detected as a boundary - this is a deliberately
// simple heuristic, not an abbreviation dictionary.
const RE_SENTENCE_BOUNDARY = /[.!?]+(?:(?=\s+[A-Z])|(?=\s*$))|\n+/g;

// Trailing sentence/bracket punctuation that can follow a node id without being part of
// it, e.g. "(node_id: 0003)" or "node_id: abc-123.".
function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:)\]}]+$/, "");
}

function sentenceBoundaries(text: string): number[] {
  const bounds: number[] = [];
  for (const m of text.matchAll(RE_SENTENCE_BOUNDARY)) {
    bounds.push((m.index ?? 0) + m[0].length);
  }
  return bounds;
}

// Number of sentence boundaries at or before `pos`, i.e. which sentence `pos` falls in.
function sentenceIndexAt(bounds: number[], pos: number): number {
  let idx = 0;
  for (const b of bounds) {
    if (b <= pos) idx++;
    else break;
  }
  return idx;
}

function pageRangeToken(page: { from: number; to: number }): string {
  return page.from === page.to ? `p${page.from}` : `p${page.from}-${page.to}`;
}

// Canonical token for a document, optionally carrying a page and/or a node.
//
// Judgment call: when a page AND a node are cited for the same document in the same
// sentence, this emits ONE citation carrying both fields rather than two. The Citation
// shape allows both fields to be set at once, and a page plus a node describing the same
// document still name a single verification target - one `getDocument` lookup. Splitting
// them into two citations would double-count a single agent statement. The combined
// canonical form appends "&n<id>" after the page suffix ("report.pdf#p5&n0003") so it
// stays unambiguous and round-trippable by eye: "#p" always introduces the page, "&n"
// always introduces the node, and the ordering of the two markers in the token is fixed
// regardless of which order they appeared in the source text.
function canonicalToken(docFull: string, page: { from: number; to: number } | null, nodeId: string | null): string {
  let token = docFull;
  if (page) token += `#${pageRangeToken(page)}`;
  if (nodeId) token += page ? `&n${nodeId}` : `#n${nodeId}`;
  return token;
}

interface DocMention {
  start: number;
  full: string;
  page: { from: number; to: number } | null;
}

interface NodeMention {
  start: number;
  id: string;
}

interface Instance {
  index: number;
  citation: Citation;
}

export function extractCitations(text: string): Citation[] {
  const bounds = sentenceBoundaries(text);

  const pageByStart = new Map<number, { from: number; to: number }>();
  for (const m of text.matchAll(RE_DOC_PAGE)) {
    const from = Number(m[2]);
    const to = m[3] !== undefined ? Number(m[3]) : from;
    pageByStart.set(m.index ?? 0, { from, to });
  }

  const docMentions: DocMention[] = [];
  for (const m of text.matchAll(RE_DOC)) {
    const start = m.index ?? 0;
    docMentions.push({ start, full: m[0], page: pageByStart.get(start) ?? null });
  }

  const nodeMentions: NodeMention[] = [];
  for (const m of text.matchAll(RE_NODE_ID)) {
    const id = stripTrailingPunctuation(m[1]);
    // Nothing left after stripping (e.g. "node_id: ..."): not a citation. An empty id
    // must not become an empty nodeId, nor bind to (and thereby suppress) a real document
    // mention nearby.
    if (!id) continue;
    nodeMentions.push({ start: m.index ?? 0, id });
  }

  // Bind each node to the nearest document mention in the SAME sentence - order-
  // independent, since real drafts cite a source and then a node either way round
  // ("report.pdf, node_id: 0003" and "node_id: 0003 in report.pdf" both bind). "Nearest"
  // is a deliberately simple, defensible tie-break for the rare case of more than one
  // document in a sentence; it is not exercised by a required test. A document mention
  // consumed by a node bind is not ALSO emitted as a separate bare/paged citation - the
  // node-carrying citation already names it, per the canonical-token rule above.
  const claimed = new Set<number>(); // DocMention.start values consumed by a node bind
  const instances: Instance[] = [];

  for (const node of nodeMentions) {
    const sentence = sentenceIndexAt(bounds, node.start);
    let nearest: DocMention | null = null;
    let nearestDistance = Infinity;
    for (const doc of docMentions) {
      if (sentenceIndexAt(bounds, doc.start) !== sentence) continue;
      const distance = Math.abs(doc.start - node.start);
      if (distance < nearestDistance) {
        nearest = doc;
        nearestDistance = distance;
      }
    }

    if (nearest) {
      claimed.add(nearest.start);
      instances.push({
        index: Math.min(nearest.start, node.start),
        citation: {
          token: canonicalToken(nearest.full, nearest.page, node.id),
          docName: nearest.full,
          pages: nearest.page,
          nodeId: node.id,
        },
      });
    } else {
      // No document anywhere in this node's sentence: unverifiable by construction.
      instances.push({
        index: node.start,
        citation: { token: `node_id:${node.id}`, docName: null, pages: null, nodeId: node.id },
      });
    }
  }

  for (const doc of docMentions) {
    if (claimed.has(doc.start)) continue;
    instances.push({
      index: doc.start,
      citation: {
        token: canonicalToken(doc.full, doc.page, null),
        docName: doc.full,
        pages: doc.page,
        nodeId: null,
      },
    });
  }

  // Unique by canonical token, in first-seen order across ALL patterns - sorting by text
  // position before deduping is what makes this cross-pattern rather than per-pattern.
  instances.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const result: Citation[] = [];
  for (const inst of instances) {
    if (seen.has(inst.citation.token)) continue;
    seen.add(inst.citation.token);
    result.push(inst.citation);
  }
  return result;
}
