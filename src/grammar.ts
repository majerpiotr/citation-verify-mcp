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

// Re-review fix (Critical 1): the name character class is Unicode-aware, not ASCII-only.
// It used to be [A-Za-z0-9_.-], which meant the greedy run was cut at the FIRST non-ASCII
// letter and the surviving FRAGMENT was then checked as though it were the document name:
// a real, existing "rapport-général-2024.pdf" was looked up as "ral-2024.pdf", came back
// `unresolved`, and a consuming agent deleted a correctly cited document (CLAUDE.md hard
// rule 4). Worse, two different names truncating to the same fragment deduped into one
// citation, so the second document was reported in no status at all. A fragment must never
// be emitted as a token, and the corpus this tool serves is not ASCII-only, so the class
// admits Unicode letters, marks and digits alongside the punctuation already allowed.
//
// The extension itself is unchanged: still required, and still matched verbatim
// case-insensitively per docs/spike-b-findings.md section 4 (lookups are case-sensitive, so
// the NAME is never case-normalized).
const NAME_CHARS = String.raw`\p{L}\p{M}\p{N}_\-`;

// CONTAINMENT for the widening above. Widening a character class is how over-reach is born,
// and this one has exactly one over-reach: a script that does not separate words with
// spaces gives the greedy run no boundary to stop at, so it would swallow the whole
// preceding clause and report THAT as the document name - "我们在这个文件里看到报告.pdf"
// - a token the author never wrote, checked and reported `unresolved`, i.e. the deletion
// hard rule 4 exists to prevent. Characters from those scripts therefore END the run, which
// leaves their behaviour exactly as it was before the widening: a bare name in such a script
// is not extracted at all (silence, the safe direction), while a space-delimited name glued
// directly to such text still is. Quoting remains the supported, exact route for them - see
// RE_QUOTED_DOC below, which deliberately carries NO script restriction. Scripts that do
// separate words with spaces (Latin, Cyrillic, Greek, Hangul, Arabic, Devanagari, ...) are
// all admitted, so this list needs no maintenance as new ones appear: anything not named
// here behaves like Latin.
const NO_SPACE_SCRIPTS = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}`;
const NAME_CHAR = String.raw`(?![${NO_SPACE_SCRIPTS}])[${NAME_CHARS}]`;
const NAME_OR_DOT_CHAR = String.raw`(?![${NO_SPACE_SCRIPTS}])[${NAME_CHARS}.]`;

// Zero-width guard: a bare match may only START where its run of name characters starts,
// i.e. where the preceding character could not have been part of the name. Two branches,
// because a no-space-script character is a letter and so would satisfy the first lookbehind
// while being excluded from the name class - it ENDS a run, so a match may start right
// after it.
//
// This is behaviour-preserving, not a narrowing. The name class is greedy and unbounded, so
// whenever a match exists starting inside a run, the same match (extended leftwards) also
// exists starting at that run's first character - the engine simply reached it by a longer
// route. What the guard removes is only that route: without it, every position inside a long
// run was tried as a start, each one re-scanning the rest of the run, which made the pass
// quadratic in the length of an unbroken run. That is a denial of service on input this tool
// does not control - a model writes the draft - so it is a correctness concern for the
// server's availability, not a micro-optimization. Measured on a 20k-character run:
// 22s -> 4ms (non-ASCII), 983ms -> 4ms (ASCII). Pinned by the timing tests in
// test/grammar.test.ts, and by a differential fuzz over ~200k random inputs that found no
// behaviour difference.
const NAME_RUN_START = String.raw`(?:(?<![${NAME_CHARS}.])|(?<=[${NO_SPACE_SCRIPTS}]))`;

// A document name may itself contain dots (annual.report.pdf), but must end in at least
// one real name character (letter/mark/digit/_/-) right before the extension - not another
// dot - so a stray "..pdf" with no actual name is never captured as a citation. The class is
// greedy and the trailing extension forces the engine to backtrack to the LAST valid
// ".pdf" in the run, so a dotted name is captured whole rather than truncated at the first
// dot. Space is deliberately excluded, so a bare (unquoted) name can never span a word
// boundary into neighbouring prose. Every alternative is non-capturing, so embedding this
// pattern never shifts a caller's group numbering.
//
// KNOWN, DELIBERATE LIMITATION: a bare name that itself contains a space (e.g. a real file
// "Annual Report 2024.pdf") is unrecoverable from prose alone - "The source is Annual
// Report 2024.pdf" gives no signal for how far back the name extends, and guessing would
// risk swallowing unrelated words. Such names are read as their last space-free segment
// ("2024.pdf"), which will not match the real file and reports unresolved/unchecked rather
// than resolved - never a false resolve, but a real citation to a space-bearing name goes
// unverified unless it is quoted (see RE_QUOTED_DOC below, which IS exact). This gap must
// be disclosed to the consuming agent in the tool description (a later task).
const DOC_NAME_PATTERN = String.raw`${NAME_RUN_START}(?:${NAME_OR_DOT_CHAR})*(?:${NAME_CHAR})\.${PDF_EXT}`;

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
//
// Unlike the BARE pattern above, this one carries no script restriction: a delimited name
// is an explicit, exact statement by the author of where the name starts and ends, so there
// is no run for a no-space script to swallow. Quoting is therefore the supported route for
// exactly the names the bare pattern declines.
function quotedNameFragment(delim: string): string {
  return `${delim}([^${delim}]*[${NAME_CHARS}]\\.${PDF_EXT})${delim}`;
}

// One capturing group (the name) per delimiter alternative.
const QUOTED_DOC_GROUP_STRIDE = 1;
const RE_QUOTED_DOC = new RegExp(QUOTE_DELIMITERS.map(quotedNameFragment).join("|"), "gu");

// Re-review ruling: a structurally-matched quote is only ACCEPTED as a document name when
// it is genuinely file-name-shaped, not merely because it ends in ".pdf" somewhere inside
// a delimiter pair - an ordinary quotation ("the data comes from report.pdf") or a
// markdown/code span can easily satisfy the structural pattern above without being a file
// name. All four conditions must hold:
//   - matches ^[letter or digit][name char, space or dot]*\.pdf$ (extension
//     case-insensitive), i.e. starts with a real character, contains only name-shaped
//     characters and spaces, and has no leading/trailing whitespace inside the delimiters
//     (enforced by the anchors). Unicode-aware, matching the bare name class - an
//     ASCII-only shape test would reject every non-ASCII name and silently push it back to
//     the bare pass, which is exactly the fragment path this round removed.
//   - at most MAX_DELIMITED_NAME_WORDS space-separated words
//   - at most MAX_DELIMITED_NAME_CHARS characters
// A REJECTED span is treated as if it were never quoted at all: it must not be added to
// quotedSpans, so the bare match inside it (e.g. plain "report.pdf") still surfaces. This
// is the important half of the fix - suppression is what turned an over-match into a
// deleted valid citation in the probe that prompted this round.
const MAX_DELIMITED_NAME_CHARS = 80;
const MAX_DELIMITED_NAME_WORDS = 4;
const RE_FILE_NAME_SHAPE = new RegExp(
  String.raw`^[\p{L}\p{N}][${NAME_CHARS} .]*\.${PDF_EXT}$`,
  "u",
);

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
// Accepts a hyphen or an en dash (each with OPTIONAL surrounding horizontal whitespace -
// "5-7" and "5 - 7" both work, matching what "to" below already allowed; the inconsistency
// was invisible in testing because only the tight forms were exercised, and a spaced dash
// silently truncated the range to its first page, same false-`resolved` harm as the
// untrimmed "to" gap), or the word "to" (surrounded by MANDATORY horizontal whitespace, so
// it cannot glue to the digits either side - "5to7" is not a range). The en dash is what
// most editors produce for "5-7" once autocorrect/smart-punctuation gets involved; "to" is
// what an agent writing prose naturally produces ("pages 5 to 7") - dropping the second
// page silently there was a real, tool-description-audited false `resolved` (a citation
// partly fabricated reads as fully verified), not merely under-checking, so both are fixed
// rather than left as documented gaps. Case-insensitive via ci(), matching every other
// keyword in this grammar. This constant is shared with the quoted-name page pattern too,
// so a quoted name's page range gets the same coverage for free.
const RANGE_SEP = String.raw`(?:[ \t]*[-–][ \t]*|[ \t]+${ci("to")}[ \t]+)`;

// Every bare (unquoted) document mention. Used both to emit doc-only citations and as one
// source of anchors a node id can bind to (see the binding pass below).
const RE_DOC = new RegExp(DOC_NAME_PATTERN, "gu");

// Whole-branch review fix (defect 1): a bare, unquoted match must not be read as a citable
// document when it is actually the trailing segment of a URL, e.g.
// "https://example.com/whitepaper.pdf". The bracket-tag path already excludes a URL-valued
// tag entirely (see the "://" check on RE_BRACKET_TAG values below, for spike-a Shape 3: "a
// different citation family this tool must not resolve") - the SAME rule must hold for a
// bare, unbracketed URL, or the two paths disagree about the identical input shape and a
// perfectly valid external reference gets read as an unresolved (and then deleted)
// citation.
//
// Signal: scan backward from the match's start, staying within the contiguous run of
// non-whitespace characters immediately preceding it on the SAME LINE (a real URL has no
// internal whitespace, and a newline always ends the run), and check whether that run
// contains "://" anywhere. This reuses the exact same substring test the bracket-tag path
// already applies, rather than inventing a second, possibly-inconsistent detector.
//
// Deliberate scope decision, made explicitly rather than left implicit:
//   - Scheme-relative ("//example.com/doc.pdf") is NOT treated as a URL here. Bare "//" is
//     a much weaker signal than "://" - it is not unique to URLs - and widening the check
//     to it would risk rejecting a legitimate name for an unproven real-world benefit. This
//     keeps the bare-match rule consistent with the bracket-tag rule, which also only
//     recognizes "://".
//   - A bare host with no scheme marker at all ("example.com/doc.pdf") is NOT treated as a
//     URL either. There is no reliable syntactic signal that distinguishes "a domain" from
//     an ordinary dotted document-name segment - DOC_NAME_PATTERN already allows dots and
//     hyphens in a real name - so attempting to detect this would risk rejecting a
//     legitimate name merely because some unrelated URL-shaped text appears elsewhere.
//     "://" is the one unambiguous signal available; both weaker forms are left unhandled
//     rather than guessed at.
//   - The rule only ever looks BACKWARD from a specific match, and only within its own
//     unbroken URL-character run, so a URL appearing elsewhere in the text (a different
//     run) never affects an unrelated, legitimate document mention.
//
// Re-review fix (Important 3): the run used to end only at one of four ASCII whitespace
// characters, so ANY other character gluing a real citation to a preceding URL kept that
// citation inside the URL's run and dropped it in EVERY status - not `unresolved`, not
// `unchecked`, simply absent from the output, which reads to a consuming agent as "nothing
// here needed checking". The run now ends at the first character that cannot appear in a
// URL at all, which is what actually bounds a URL: every kind of Unicode whitespace
// (U+00A0 in particular), dashes other than "-", typographic quotes, and the rest.
//
// DISCLOSED LIMITATION, deliberately not fixed: a character a URL path MAY legally contain
// - ";", ",", "(", ")" and the other RFC 3986 sub-delimiters - does NOT end the run, so a
// citation glued to a URL by one of them is still dropped. Breaking on them would
// un-suppress the FINAL path segment of any real URL containing one earlier in its path
// (".../w_100,h_200/report.pdf"), which is a common shape - turning a safe silence into a
// false `unresolved` that makes a consuming agent delete a valid reference. Under CLAUDE.md
// hard rule 4 silence is the safe direction here, so the gap is disclosed rather than
// traded for a worse failure.
//
// Unicode letters/marks/digits continue the run too: an IRI path segment may contain them
// unencoded, and cutting the run there would un-suppress the tail of a non-ASCII URL.
const RE_URL_RUN_CHAR = /[\p{L}\p{M}\p{N}\-._~:\/?#\[\]@!$&'()*+,;=%]/u;

function isUrlPrefixed(text: string, start: number): boolean {
  let i = start;
  // Non-global regex: `.test` carries no lastIndex state, so this is safe to call in a loop.
  while (i > 0 && RE_URL_RUN_CHAR.test(text[i - 1])) i--;
  return text.slice(i, start).includes("://");
}

// Tool-description audit: "report.pdf (page 5)" and "report.pdf on page 5" are common
// real prose forms that the plain [,;]? separator below does not reach, so the page claim
// was silently dropped (a citation reported `resolved` with the page half never checked -
// "silence reads as endorsement"). Widened to a CLOSED set of forms, deliberately not an
// open-ended "any short word" rule:
//   - an opening ( or [ immediately before the keyword (optional surrounding horizontal
//     whitespace); the matching closer after the page number is optionally consumed as
//     punctuation, never captured, and never required (an unbalanced "(page 5" still
//     binds, since the open bracket alone is already unambiguous)
//   - one connector word from a CLOSED list - on, at, see - optionally preceded by the
//     existing , or ;, with MANDATORY whitespace on both sides so it can only match a
//     whole standalone word, never a substring of a longer one
// Both new forms stay same-line only (the `\b` word boundaries and `[ \t]` classes never
// include `\n`) - the newline restriction below is what stops a page marker on a LATER
// line from binding to a document on an EARLIER one, and widening this separator must not
// reopen that. The connector list being closed - not "any word" - is what stops the
// separator from spanning an intervening document mention: "a.pdf and b.pdf on page 5"
// fails to match starting at "a.pdf" (the mandatory whitespace right after a connector
// attempt can't reach past "and", which isn't in the list), so it can only match starting
// at "b.pdf".
const CONNECTOR_WORD = String.raw`\b(?:${ci("on")}|${ci("at")}|${ci("see")})\b`;
const OPEN_BRACKET = String.raw`[(\[]`;
const CLOSE_BRACKET = String.raw`[)\]]?`;
const DOC_PAGE_SEP = String.raw`(?:[,;]?[ \t]*(?:${CONNECTOR_WORD}[ \t]+)?|[ \t]*${OPEN_BRACKET}[ \t]*)`;

// A document followed by a page marker on the SAME LINE, separated by DOC_PAGE_SEP above -
// no other words beyond the closed connector list, and never a newline. Judgment call
// (docs/rework-plan.md Task R2 leaves the exact proximity open): a page reference in a
// real draft is almost always glued to the name it narrows ("report.pdf p.5") or joined by
// one of the forms above, so this stops short of arbitrary same-sentence distance, which
// would risk pairing a page number with the wrong document when a sentence mentions more
// than one.
const RE_DOC_PAGE = new RegExp(
  String.raw`(${DOC_NAME_PATTERN})${DOC_PAGE_SEP}${PAGE_KEYWORD}[ \t]*(${PAGE_NUMBER})(?:${RANGE_SEP}(${PAGE_NUMBER}))?${CLOSE_BRACKET}`,
  "gu",
);

// Reuses DOC_PAGE_SEP and CLOSE_BRACKET verbatim - the exact bug this fixes was that this
// function had its own copy of the separator ([,;]?[ \t]*) that silently fell out of sync
// when RE_DOC_PAGE's was widened for brackets and connector words: quoting a name is
// exactly what this grammar tells a caller to do for a real file name containing a space
// (see the KNOWN, DELIBERATE LIMITATION comment on DOC_NAME_PATTERN above), so it was the
// worst possible place for the two paths to drift - the recommended, spaces-safe form was
// silently losing its page while the bare form worked. One shared definition, used by both
// call sites, is what stops that drift from being reintroduced by a future change to only
// one of them.
function quotedPageFragment(delim: string): string {
  return (
    `${delim}([^${delim}]*[${NAME_CHARS}]\\.${PDF_EXT})${delim}` +
    `${DOC_PAGE_SEP}${PAGE_KEYWORD}[ \\t]*(${PAGE_NUMBER})(?:${RANGE_SEP}(${PAGE_NUMBER}))?${CLOSE_BRACKET}`
  );
}

// Same doc+page adjacency rule as RE_DOC_PAGE, but anchored on a quoted name: a page or
// node marker may follow the closing delimiter and binds exactly as it would a bare name.
// Each delimiter alternative carries its own (name, from, to) group triplet - read via
// QUOTED_PAGE_GROUP_STRIDE below rather than named groups, to avoid depending on the
// "duplicate named capturing groups" proposal that not every supported engine has.
const QUOTED_PAGE_GROUP_STRIDE = 3;
const RE_QUOTED_DOC_PAGE = new RegExp(QUOTE_DELIMITERS.map(quotedPageFragment).join("|"), "gu");

// node_id: <id> or node_id=<id>. The id charset intentionally includes characters (like
// "." and "/") that can also be sentence punctuation or look like a path/extension;
// stripTrailingPunctuation below cleans up a trailing one, and the reserved-span exclusion
// in extractCitations stops a ".pdf"-shaped substring INSIDE a node id (e.g.
// "node_id: sub/chapter.pdf") from being separately read as a document (Important 6) - the
// id's own text must never synthesize a document, which is exactly the failure mode
// docs/spike-b-findings.md section 6 exists to prevent.
const RE_NODE_ID = new RegExp(String.raw`${NODE_ID_KEYWORD}[:=]\s*([A-Za-z0-9_\-./]+)`, "gd");

// A generic bracket-tag citation, e.g. "[node:some-doc-id-123]" or "[chunk:abc-42]" -
// docs/spike-a-findings.md investigated a real consuming application and found that ALL of
// its ~25 citing agent roles are instructed to cite in exactly this shape, with "node" as
// the keyword, yet this grammar had no rule for it at all: not a partial or wrong match,
// invisible to every pattern here, so such a citation never appeared in the tool's output
// in any form - "silence reads as endorsement" (spike-a section on Shape 1). The keyword
// itself is deliberately generic (`[A-Za-z]+`, not a hardcoded "node") per the spike's own
// recommendation: that one application independently invented a second bracket-tag
// convention ("Source:") for a different citation family, so a future host is likely to
// invent a third word, and the keyword is never reported anywhere in the resulting
// Citation - only the id is - so which word was used makes no difference to the verdict.
// Colon may have horizontal whitespace on either side; the value stops at the closing `]`
// or a newline, whichever comes first, so a stray unclosed "[" can never swallow unrelated
// later text.
const RE_BRACKET_TAG = /\[[A-Za-z]+[ \t]*:[ \t]*([^\]\n]+)\]/gd;

// Whole-branch review fix (defect 2), corrected by the re-review (Critical 2): true when a
// bracket-tag's VALUE names a document as a WHOLE, standalone token. Determines whether the
// bracket-tag loop below should step aside and let the ordinary document/page/node scans -
// which run unconditionally over the whole text - read the real citation out of the value,
// instead of reserving the span and reporting a synthetic "node_id:<raw value>" token.
//
// The boundary test is the whole point. RE_DOC has no trailing boundary, so a plain
// "does it match anywhere" test returned true for any id that merely CONTAINED a
// ".pdf"-shaped substring: "[node: sub/chapter.pdf]" stepped aside and the bare pass then
// looked up "chapter.pdf" as a document and reported it `unresolved`, while the IDENTICAL
// id written as "node_id: sub/chapter.pdf" correctly stayed `unchecked` (the node_id: path
// reserves its captured span precisely to prevent this). Two syntaxes for the same id space
// disagreeing about the same id, in the direction that makes a consuming agent delete an
// unverifiable-by-construction citation, is exactly what CLAUDE.md hard rule 4 forbids.
//
// So the match must not be glued to a LONGER IDENTIFIER on either side: the character next
// to it must not be one an identifier can continue with - a letter, mark, digit, "_", "-",
// "/", or a "." that itself leads back into one of those (a trailing "." ending the value is
// sentence punctuation, not a continuation). "report.pdf", "report.pdf p.12",
// `"Annual Report.pdf"` and "see report.pdf, node_id: 0003" all qualify; "sub/chapter.pdf",
// "v1.pdf-part2", "report.pdfx" and "2024.pdf.chunk3" do not, and stay `unchecked`.
//
// The test is deliberately "not part of a bigger identifier" rather than "surrounded by
// whitespace": a stricter whitespace rule made "[cite: `"Annual Report.pdf"`]" `unchecked`,
// which is the mirror failure - quoting is precisely what this grammar tells a caller to do
// for a name containing a space, so a quoted name inside a bracket tag must reach the
// ordinary passes and be CHECKED, not hidden behind docName: null.
//
// Uses matchAll (never .test()/.exec()) on the module-level `g` regex, per this grammar's
// own rule, and matchAll is safe to call repeatedly / on a substring: it constructs its own
// iterator per call rather than mutating RE_DOC's shared lastIndex.
const RE_ID_CONTINUES_BEFORE = /[\p{L}\p{M}\p{N}_\-\/]\.*$/u;
const RE_ID_CONTINUES_AFTER = /^\.*[\p{L}\p{M}\p{N}_\-\/]/u;

function containsStandaloneDocName(value: string): boolean {
  for (const m of value.matchAll(RE_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (RE_ID_CONTINUES_BEFORE.test(value.slice(0, start))) continue;
    if (RE_ID_CONTINUES_AFTER.test(value.slice(end))) continue;
    return true;
  }
  return false;
}

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

// Reserved-span bookkeeping: "has an earlier pass already claimed these characters?".
//
// This used to be an array of [start, end) pairs scanned linearly per query, which is
// quadratic in the NUMBER of citations rather than the length of the text - a draft made up
// mostly of quoted names cost 645 ms at 160k characters and grew 4x per doubling. Same
// reasoning as the run-start guard on DOC_NAME_PATTERN: the text is untrusted, so cost has
// to stay linear in it. A byte mask answers a query in time proportional to the MATCH
// length, and marking every span is linear in the text. Behaviour is identical - all spans
// here are non-empty (every capturing group behind them requires at least one character),
// so "any marked byte in [start, end)" and "start < e && s < end" agree exactly.
function reserveSpan(mask: Uint8Array, start: number, end: number): void {
  mask.fill(1, start, end);
}

function overlapsReserved(mask: Uint8Array, start: number, end: number): boolean {
  return mask.subarray(start, end).indexOf(1) !== -1;
}

export function extractCitations(text: string): Citation[] {
  const bounds = sentenceBoundaries(text);
  const instances: Instance[] = [];

  // Identifier-like citations first (node_id: and the generic bracket tag): their own
  // matched span is a reserved span that later document scans must never read a citation
  // out of (Important 6) - "node_id: sub/chapter.pdf" must not let "chapter.pdf" be
  // discovered as a document, and neither must "[node:report.pdf]".
  const nodeMentions: NodeMention[] = [];
  const idSpans = new Uint8Array(text.length);
  for (const m of text.matchAll(RE_NODE_ID)) {
    const start = m.index ?? 0;
    // `d` flag: exact span of the captured id group (group 1), not the whole
    // "node_id: ..." match - a document mentioned before the keyword must stay readable.
    const groupSpan = m.indices?.[1];
    if (groupSpan) reserveSpan(idSpans, groupSpan[0], groupSpan[1]);
    const id = stripTrailingPunctuation(m[1]);
    // Nothing left after stripping (e.g. "node_id: ..."): not a citation. An empty id
    // must not become an empty nodeId, nor bind to (and thereby suppress) a real document
    // mention nearby.
    if (!id) continue;
    nodeMentions.push({ start, id });
  }

  // Generic bracket-tag citations ("[node:<id>]", "[chunk:<id>]", ...) - see RE_BRACKET_TAG
  // above for why the keyword is generic and docs/spike-a-findings.md for why this exists
  // at all. Deliberately does NOT feed into nodeMentions / the binding pass below: unlike
  // node_id:, which names this grammar's own understanding of the backend's real
  // per-document node ordinal (docs/spike-b-findings.md) and can therefore be meaningfully
  // checked against a bound document's real node set, a bracket-tag id is a host-invented
  // slug from a wholly different, unconfirmed id space. Binding it to a nearby document
  // would let the resolver run a real per-document node check against an id that was never
  // drawn from that space - risking the dangerous false `unresolved` direction (CLAUDE.md
  // hard rule 4) for no benefit, since the spike found these ids never correspond to real
  // backend node ids or file names either way. So every bracket tag emits its own
  // stand-alone citation, unconditionally `docName: null`, regardless of what else is in
  // the sentence. Canonical token deliberately reuses the exact "node_id:<id>" prefix an
  // unbound node_id: citation already uses (not a new "bracket:<id>" shape) - both reduce
  // to the identical Citation fields, and a consuming agent should not see two
  // different-looking citations for what is, after verification, the same unverifiable
  // claim; this also means an equivalent node_id: and bracket-tag citation for the same id
  // dedupe into one, via the existing first-seen-by-token logic below.
  for (const m of text.matchAll(RE_BRACKET_TAG)) {
    const start = m.index ?? 0;
    const groupSpan = m.indices?.[1];
    const value = m[1].trim();
    if (!value) continue; // e.g. "[node:]" - nothing to cite
    // A URL-valued tag belongs to a different citation family entirely (spike-a Shape 3:
    // "[Source: <url>]", the "web analogue of PageIndex node citations" for a role that
    // cites external sources, not the document corpus). This tool verifies PageIndex
    // documents only and must not attempt to resolve a web source. "://" is the simplest
    // defensible signal: every URL scheme actually in use (http, https, even a bare
    // "file://") includes it, an ordinary slug/id never does, and it needs no allowlist of
    // schemes that could go stale as new ones appear.
    //
    // Re-review correction (Minor 5): an earlier comment here claimed the position of this
    // check - before the document-shape check below - was load-bearing. It is not, and no
    // test can make it so: BOTH checks take the identical action (step aside, reserving
    // nothing and emitting nothing), so their relative order cannot change any output. It
    // is written first only because a URL is the cheaper thing to recognize. What IS
    // load-bearing is that both run BEFORE the reserve-and-emit code below.
    if (value.includes("://")) continue;
    // Whole-branch review fix (defect 2): previously this loop reserved the ENTIRE
    // captured value as an idSpan and always emitted an opaque `node_id:<raw value>`
    // citation, unconditionally - which swallowed a REAL citation whole whenever the value
    // itself named a document ("[cite: fabricated-report.pdf]", "[Source: report.pdf
    // p.12]"). CLAUDE.md hard rule 4: a consuming agent is told to KEEP every `unchecked`
    // citation, so a fabricated document hidden behind docName: null was preserved by
    // policy instead of being checked and reported `unresolved` - the mirror failure of
    // defect 1. When the value is document-shaped, step aside entirely: reserve nothing
    // here, emit nothing here, and let the ordinary document/page/node passes below - which
    // already scan the WHOLE text unconditionally, brackets or not - read the real citation
    // straight out of the value's own character span (this also lets a node_id: cited in
    // the same bracket bind to that document exactly as it would in ordinary prose). Only a
    // value that does not name a document as a standalone token (an invented slug like
    // "some-doc-id-123", or a path-shaped id like "sub/chapter.pdf") keeps the original
    // reserve-the-span-and-report-unchecked behavior.
    //
    // Accepted consequence, pinned by test: when the value carries BOTH a slug and a
    // standalone document ("[node: abc-123 report.pdf]"), the whole tag steps aside, so the
    // slug is not reported in any status. The slug is unverifiable either way, whereas the
    // document is a checkable claim that must not hide behind `unchecked`.
    if (containsStandaloneDocName(value)) continue;
    if (groupSpan) reserveSpan(idSpans, groupSpan[0], groupSpan[1]);
    instances.push({
      index: start,
      citation: { token: `node_id:${value}`, docName: null, pages: null, nodeId: value },
    });
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

  const quotedSpans = new Uint8Array(text.length);
  const docMentions: DocMention[] = [];
  for (const m of text.matchAll(RE_QUOTED_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const full = delimiterGroup(m, QUOTED_DOC_GROUP_STRIDE, 1);
    if (full === undefined || !isFileNameShaped(full)) continue; // not a name: ignore the quote entirely
    // Re-review fix (Minor 4): the URL exclusion used to be applied to the bare pass only,
    // so a URL's own path segment was still extracted whenever it happened to be delimited
    // ("https://example.com/`report.pdf`"). Both the README and the tool description state
    // flatly that a URL's path segment is not extracted in any status, so the quoted pass
    // has to honour the same rule. The span is still RESERVED (unlike a span rejected by
    // isFileNameShaped above): dropping it silently would leave the bare match inside the
    // delimiters free to be picked up by the bare pass, where the delimiter itself now ends
    // the URL run - the exclusion would undo itself one pass later.
    if (isUrlPrefixed(text, start)) {
      reserveSpan(quotedSpans, start, end);
      continue;
    }
    if (overlapsReserved(idSpans, start, end)) continue;
    reserveSpan(quotedSpans, start, end);
    docMentions.push({ start, end, full, page: quotedPageByStart.get(start) ?? null });
  }

  // Bare (unquoted) document mentions, excluding anything already claimed by an
  // identifier's own text or by a quoted name covering the same span.
  const pageByStart = new Map<number, { from: number; to: number }>();
  for (const m of text.matchAll(RE_DOC_PAGE)) {
    const from = Number(m[2]);
    const to = m[3] !== undefined ? Number(m[3]) : from;
    pageByStart.set(m.index ?? 0, { from, to });
  }
  for (const m of text.matchAll(RE_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlapsReserved(idSpans, start, end) || overlapsReserved(quotedSpans, start, end)) continue;
    if (isUrlPrefixed(text, start)) continue; // defect 1: a URL's own path is not a document
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
