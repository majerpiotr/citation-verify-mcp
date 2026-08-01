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
// e.g. ci("p.") -> "[pP]\.". Used for the page/node KEYWORDS (p., pp., page, pages,
// node_id) AND for the .pdf extension itself - a real corpus can contain "REPORT.PDF", and
// silently failing to recognize it as a citation is as dangerous as mis-checking one (a
// fabricated uppercase-extension name would then get a clean, unverified pass). The
// document NAME portion is still captured and reported verbatim, case untouched - the
// backend looks documents up by exact file name (docs/spike-b-findings.md section 4), so
// normalizing case would turn a valid citation into a false `unresolved`.
function ci(literal: string): string {
  return [...literal]
    .map((ch) =>
      /[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
}

const PDF_EXT = ci("pdf");

// A document name may itself contain dots (annual.report.pdf), but must end in at least
// one real name character (letter/digit/_/-) right before the extension - not another dot
// - so a stray "..pdf" with no actual name is never captured as a citation. The class is
// greedy and the trailing extension forces the engine to backtrack to the LAST valid
// ".pdf" in the run, so a dotted name is captured whole rather than truncated at the first
// dot. Space is deliberately excluded, so a bare (unquoted) name can never span a word
// boundary into neighbouring prose.
//
// KNOWN, DELIBERATE LIMITATION: a bare name that itself contains a space (e.g. a real file
// "Annual Report 2024.pdf") is unrecoverable from prose alone - "The source is Annual
// Report 2024.pdf" gives no signal for how far back the name extends, and guessing would
// risk swallowing unrelated words. Such names are read as their last space-free segment
// ("2024.pdf"), which will not match the real file and reports unresolved/unchecked rather
// than resolved - never a false resolve, but a real citation to a space-bearing name goes
// unverified unless it is quoted (see RE_QUOTED_DOC below, which IS exact). This gap must
// be disclosed to the consuming agent in the tool description (a later task).
const DOC_NAME_PATTERN = String.raw`[A-Za-z0-9_.\-]*[A-Za-z0-9_\-]\.${PDF_EXT}`;

// A document name wrapped in double quotes or backticks is taken verbatim, spaces
// included, and the delimiters are not part of the name. This is the supported way to
// cite a document whose real file name contains a space - see the limitation above.
//
// Single quote deliberately dropped as a delimiter (re-review ruling): English prose uses
// apostrophes constantly ("don't", "report.pdf's", "the team's"), and a real file name
// wrapped in single quotes in agent output is vanishingly rare. Treating `'` as a
// delimiter turned an ordinary possessive or contraction into an invented document name.
const QUOTE_DELIMITERS = ['"', "`"];

// The raw structural match: any content up to the (fixed) closing delimiter, ending in a
// real name character before the extension. This alone is NOT sufficient to accept the
// span as a document name - see isFileNameShaped below, which is what actually decides
// whether a match is a citation or ordinary prose that happens to contain ".pdf".
function quotedNameFragment(delim: string): string {
  return `${delim}([^${delim}]*[A-Za-z0-9_\\-]\\.${PDF_EXT})${delim}`;
}

// One capturing group (the name) per delimiter alternative.
const QUOTED_DOC_GROUP_STRIDE = 1;
const RE_QUOTED_DOC = new RegExp(QUOTE_DELIMITERS.map(quotedNameFragment).join("|"), "g");

// Re-review ruling: a structurally-matched quote is only ACCEPTED as a document name when
// it is genuinely file-name-shaped, not merely because it ends in ".pdf" somewhere inside
// a delimiter pair - an ordinary quotation ("the data comes from report.pdf") or a
// markdown/code span can easily satisfy the structural pattern above without being a file
// name. All four conditions must hold:
//   - matches ^[A-Za-z0-9][A-Za-z0-9 ._-]*\.pdf$ (extension case-insensitive), i.e. starts
//     with a real character, contains only name-shaped characters and spaces, and has no
//     leading/trailing whitespace inside the delimiters (enforced by the anchors)
//   - at most MAX_DELIMITED_NAME_WORDS space-separated words
//   - at most MAX_DELIMITED_NAME_CHARS characters
// A REJECTED span is treated as if it were never quoted at all: it must not be added to
// quotedSpans, so the bare match inside it (e.g. plain "report.pdf") still surfaces. This
// is the important half of the fix - suppression is what turned an over-match into a
// deleted valid citation in the probe that prompted this round.
const MAX_DELIMITED_NAME_CHARS = 80;
const MAX_DELIMITED_NAME_WORDS = 4;
const RE_FILE_NAME_SHAPE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._-]*\\.${PDF_EXT}$`);

function isFileNameShaped(content: string): boolean {
  if (content.length === 0 || content.length > MAX_DELIMITED_NAME_CHARS) return false;
  if (!RE_FILE_NAME_SHAPE.test(content)) return false;
  const words = content.split(" ").filter((w) => w.length > 0);
  return words.length <= MAX_DELIMITED_NAME_WORDS;
}

// Reads the first defined capturing group across a set of mutually-exclusive alternation
// branches that each contribute the same number of groups (`stride`), at the same relative
// `offset` within their branch - e.g. offset 1 is always "the name" whichever delimiter
// matched. Used for BOTH RE_QUOTED_DOC (stride 1) and RE_QUOTED_DOC_PAGE (stride 3) so
// adding or removing a delimiter only ever changes QUOTE_DELIMITERS - neither call site
// hard-codes how many delimiters exist.
function delimiterGroup(m: RegExpMatchArray, stride: number, offset: number): string | undefined {
  for (let i = 0; i < QUOTE_DELIMITERS.length; i++) {
    const value = m[i * stride + offset];
    if (value !== undefined) return value;
  }
  return undefined;
}

const PAGE_KEYWORD = `(?:${ci("pp.")}|${ci("pages")}|${ci("page")}|${ci("p.")})`;
const NODE_ID_KEYWORD = ci("node_id");

// Bounds the number of digits a page number may have. Documents in this corpus are never
// remotely this long; the real purpose is to make an absurd input (e.g. a run of twenty
// 9s) FAIL to match at all rather than being parsed and then silently mangled by float
// precision loss when converted to a Number - a canonical token must stay faithful to what
// was actually written, never drift into a different number. The `(?!\d)` lookahead is
// what turns "too many digits" into "no match", rather than a truncated one: it forces the
// engine to fail every length from 1..MAX_PAGE_DIGITS in turn when more digits follow.
const MAX_PAGE_DIGITS = 6;
const PAGE_NUMBER = String.raw`\d{1,${MAX_PAGE_DIGITS}}(?!\d)`;
// Accepts a hyphen or an en dash between the two numbers of a range - the en dash is what
// most editors produce for "5-7" once autocorrect/smart-punctuation gets involved. "5 to 7"
// remains unsupported (a documented gap, not a bug): under-checking a valid range is safe,
// unlike mis-checking, so it is left for later rather than risking a speculative pattern.
const RANGE_SEP = String.raw`(?:-|–)`;

// Every bare (unquoted) document mention. Used both to emit doc-only citations and as one
// source of anchors a node id can bind to (see the binding pass below).
const RE_DOC = new RegExp(DOC_NAME_PATTERN, "g");

// A document immediately followed by a page marker, with nothing but an optional , or ;
// and HORIZONTAL whitespace between them - no other words, and never a newline. Judgment
// call (docs/rework-plan.md Task R2 leaves the exact proximity open): a page reference in a
// real draft is almost always glued to the name it narrows ("report.pdf p.5"), so requiring
// tight adjacency avoids accidentally pairing a page number with a document mentioned
// earlier in the same sentence but not the one the page actually refers to. Restricting the
// separator to `[ \t]` rather than `\s` specifically excludes newlines: a page marker that
// starts a new line belongs to different prose, not the document named above it.
const RE_DOC_PAGE = new RegExp(
  String.raw`(${DOC_NAME_PATTERN})[,;]?[ \t]*${PAGE_KEYWORD}[ \t]*(${PAGE_NUMBER})(?:${RANGE_SEP}(${PAGE_NUMBER}))?`,
  "g",
);

function quotedPageFragment(delim: string): string {
  return (
    `${delim}([^${delim}]*[A-Za-z0-9_\\-]\\.${PDF_EXT})${delim}` +
    `[,;]?[ \\t]*${PAGE_KEYWORD}[ \\t]*(${PAGE_NUMBER})(?:${RANGE_SEP}(${PAGE_NUMBER}))?`
  );
}

// Same doc+page adjacency rule as RE_DOC_PAGE, but anchored on a quoted name: a page or
// node marker may follow the closing delimiter and binds exactly as it would a bare name.
// Each delimiter alternative carries its own (name, from, to) group triplet - read via
// QUOTED_PAGE_GROUP_STRIDE below rather than named groups, to avoid depending on the
// "duplicate named capturing groups" proposal that not every supported engine has.
const QUOTED_PAGE_GROUP_STRIDE = 3;
const RE_QUOTED_DOC_PAGE = new RegExp(QUOTE_DELIMITERS.map(quotedPageFragment).join("|"), "g");

// node_id: <id> or node_id=<id>. The id charset intentionally includes characters (like
// "." and "/") that can also be sentence punctuation or look like a path/extension;
// stripTrailingPunctuation below cleans up a trailing one, and the reserved-span exclusion
// in extractCitations stops a ".pdf"-shaped substring INSIDE a node id (e.g.
// "node_id: sub/chapter.pdf") from being separately read as a document (Important 6) - the
// id's own text must never synthesize a document, which is exactly the failure mode
// docs/spike-b-findings.md section 6 exists to prevent.
const RE_NODE_ID = new RegExp(String.raw`${NODE_ID_KEYWORD}[:=]\s*([A-Za-z0-9_\-./]+)`, "gd");

// Sentence boundary, the concrete definition "same sentence" is built on: a run of .!?
// followed by whitespace (or by end of string) is a boundary; a run of newlines always
// counts too (paragraph breaks bind nothing across them).
//
// Direction matters here, and is asymmetric: a FALSE boundary makes a node come out
// `docName: null` -> `unchecked` -> safe (a consuming agent just can't verify it yet). A
// MISSED boundary attaches a node to the wrong document -> a real node lookup against the
// wrong name -> `unresolved` -> a consuming agent deletes a citation that was actually
// fine. So this deliberately over-detects (no capital-letter requirement on the next
// sentence - a lowercase or digit-initial sentence still counts) rather than under-detect.
//
// The one narrow carve-out is the page abbreviation "p." / "pp." immediately before a page
// NUMBER ("report.pdf p. 5, node_id: 0003" must stay one sentence). It is conditioned on a
// digit actually following - `p.`/`pp.` NOT followed by a digit (e.g. "report.pdf, p. Then
// node_id: 0003.") is a real sentence end and must still split. Two branches, so the
// carve-out can only ever suppress a boundary in the one case it targets, never invent one
// elsewhere:
//   1. `\b[Pp][Pp]?\.` NOT followed by a digit -> IS a boundary in its own right (closes
//      the gap: a sentence that happens to end in "p."/"pp." with no page number after it).
//   2. any other `.!?` run not immediately preceded by "p"/"pp" -> the general case.
const RE_SENTENCE_BOUNDARY =
  /\b[Pp][Pp]?\.(?![ \t]*\d)(?:\s+|\s*$)|(?<!\b[Pp])(?<!\b[Pp][Pp])[.!?]+(?:\s+|\s*$)|\n+/g;

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
// regardless of which order they appeared in the source text. NOTE for downstream (tool
// description, README): "#p<N>&n<id>" is a new canonical shape beyond the plain "#p<N>"
// and "#n<id>" forms enumerated in docs/rework-plan.md and must be documented there too.
//
// Trade-off worth carrying forward: if this merged citation resolves the document and the
// page but the node is absent, the whole citation reports one `unresolved` - the valid
// page claim is deleted along with the bad node claim, because Citation has no way to
// report "half of this citation failed". Acceptable at v0; the resolver's `suggestion`
// should say which half failed (not this task's concern).
function canonicalToken(docFull: string, page: { from: number; to: number } | null, nodeId: string | null): string {
  let token = docFull;
  if (page) token += `#${pageRangeToken(page)}`;
  if (nodeId) token += page ? `&n${nodeId}` : `#n${nodeId}`;
  return token;
}

interface DocMention {
  start: number;
  end: number; // position right after the name's visual span (closing quote, if quoted)
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

type Span = readonly [number, number];

function overlapsAny(start: number, end: number, spans: readonly Span[]): boolean {
  return spans.some(([s, e]) => start < e && s < end);
}

export function extractCitations(text: string): Citation[] {
  const bounds = sentenceBoundaries(text);

  // Node ids first: their own matched span is a reserved span that later document scans
  // must never read a citation out of (Important 6) - a node id like
  // "node_id: sub/chapter.pdf" must not let "chapter.pdf" be discovered as a document.
  const nodeMentions: NodeMention[] = [];
  const nodeIdSpans: Span[] = [];
  for (const m of text.matchAll(RE_NODE_ID)) {
    const start = m.index ?? 0;
    // `d` flag: exact span of the captured id group (group 1), not the whole
    // "node_id: ..." match - a document mentioned before the keyword must stay readable.
    const groupSpan = m.indices?.[1];
    if (groupSpan) nodeIdSpans.push([groupSpan[0], groupSpan[1]]);
    const id = stripTrailingPunctuation(m[1]);
    // Nothing left after stripping (e.g. "node_id: ..."): not a citation. An empty id
    // must not become an empty nodeId, nor bind to (and thereby suppress) a real document
    // mention nearby.
    if (!id) continue;
    nodeMentions.push({ start, id });
  }

  // Quoted document mentions - preferred over a bare match covering the same span, but
  // ONLY when the delimited content is genuinely file-name-shaped (isFileNameShaped).
  // Computed before bare mentions so an ACCEPTED span can be excluded from them; a
  // REJECTED span contributes nothing here - not a docMention, not a reserved span - so
  // the bare match inside it (e.g. plain "report.pdf" inside an ordinary quotation) is
  // left completely free to be found in the bare pass below.
  const quotedPageByStart = new Map<number, { from: number; to: number }>();
  for (const m of text.matchAll(RE_QUOTED_DOC_PAGE)) {
    const start = m.index ?? 0;
    const name = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 1);
    const from = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 2);
    if (name === undefined || from === undefined || !isFileNameShaped(name)) continue;
    const to = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 3);
    quotedPageByStart.set(start, { from: Number(from), to: to !== undefined ? Number(to) : Number(from) });
  }

  const quotedSpans: Span[] = [];
  const docMentions: DocMention[] = [];
  for (const m of text.matchAll(RE_QUOTED_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const full = delimiterGroup(m, QUOTED_DOC_GROUP_STRIDE, 1);
    if (full === undefined || !isFileNameShaped(full)) continue; // not a name: ignore the quote entirely
    if (overlapsAny(start, end, nodeIdSpans)) continue;
    quotedSpans.push([start, end]);
    docMentions.push({ start, end, full, page: quotedPageByStart.get(start) ?? null });
  }

  // Bare (unquoted) document mentions, excluding anything already claimed by a node id's
  // own text or by a quoted name covering the same span.
  const pageByStart = new Map<number, { from: number; to: number }>();
  for (const m of text.matchAll(RE_DOC_PAGE)) {
    const from = Number(m[2]);
    const to = m[3] !== undefined ? Number(m[3]) : from;
    pageByStart.set(m.index ?? 0, { from, to });
  }
  for (const m of text.matchAll(RE_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlapsAny(start, end, nodeIdSpans) || overlapsAny(start, end, quotedSpans)) continue;
    docMentions.push({ start, end, full: m[0], page: pageByStart.get(start) ?? null });
  }

  // Bind each node to the nearest document mention in the SAME sentence - order-
  // independent, since real drafts cite a source and then a node either way round
  // ("report.pdf, node_id: 0003" and "node_id: 0003 in report.pdf" both bind). Distance is
  // measured to whichever EDGE of the document mention (start or end) is nearer the node,
  // not just the start - a long name sitting immediately next to the node must not lose to
  // a short name much further away just because its start is further back. This is a
  // deliberately simple, defensible tie-break for the rare case of more than one document
  // in a sentence; it is not exercised by a required test. A document mention consumed by
  // a node bind is not ALSO emitted as a separate bare/paged citation - the node-carrying
  // citation already names it, per the canonical-token rule above.
  const claimed = new Set<number>(); // DocMention.start values consumed by a node bind
  const instances: Instance[] = [];

  for (const node of nodeMentions) {
    const sentence = sentenceIndexAt(bounds, node.start);
    let nearest: DocMention | null = null;
    let nearestDistance = Infinity;
    for (const doc of docMentions) {
      if (sentenceIndexAt(bounds, doc.start) !== sentence) continue;
      const distance = Math.min(Math.abs(doc.start - node.start), Math.abs(doc.end - node.start));
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
