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
// hard rule 4 exists to prevent. Characters from those scripts therefore never enter a name.
//
// They are also not BOUNDARY characters (see NAME_BOUNDARY below), so a name touching such
// text is not extracted from either side. That second half is what the final review found
// missing: while the whole-clause swallow was contained, the opposite cut was not, and the
// common real shape of a CJK file name - a script mixed with Latin letters or digits - was
// truncated to its Latin tail. "会议纪要_v2.pdf" was checked as "_v2.pdf" and "報告書2024.pdf"
// as "2024.pdf": fragments, `unresolved`, deleted, with the real document sitting in the
// corpus all along. The grammar cannot tell that shape from a whole Latin name written
// directly after a particle ("詳細はreport.pdf") - they are the identical run of characters
// after a no-space-script character - so the permission that served the second case is what
// destroyed the first, and it is withdrawn. Both are now silent, which is the direction hard
// rule 4 requires and exactly what the tool description and README already promise.
//
// Quoting is the supported, exact route for every one of them - see RE_QUOTED_DOC below,
// which deliberately carries NO script restriction. Scripts that do separate words with
// spaces (Latin, Cyrillic, Greek, Hangul, Arabic, Devanagari, ...) are all admitted, so this
// list needs no maintenance as new ones appear: anything not named here behaves like Latin.
const NO_SPACE_SCRIPTS = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}`;
const NAME_CHAR = String.raw`(?![${NO_SPACE_SCRIPTS}])[${NAME_CHARS}]`;
const NAME_OR_DOT_CHAR = String.raw`(?![${NO_SPACE_SCRIPTS}])[${NAME_CHARS}.]`;

// THE BOUNDARY RULE, and the single most load-bearing definition in this file: the closed
// set of characters that may sit immediately next to a bare (unquoted) document name in
// prose. Everything NOT listed here - every letter, digit, mark, and every punctuation or
// symbol character not named - is read as a CONTINUATION, meaning a name touching it is part
// of a longer token and is therefore not a citation at all.
//
// The set is an allowlist rather than a list of "characters that glue", and the direction of
// that choice is the whole point. A character wrongly listed here cuts a longer token in two
// and emits the FRAGMENT as a document: a consuming agent is told to delete what comes back
// `unresolved`, so a fragment deletes correct work (CLAUDE.md hard rule 4). A character
// wrongly ABSENT costs a real citation its check - under-reach, reported in no status,
// recoverable by quoting. An allowlist makes every unforeseen character fail in the second,
// survivable direction; a glue-list makes every unforeseen character fail in the first.
//
// Members, and why each is here:
//   - \s          every kind of whitespace, U+00A0 and the Unicode spaces included.
//   - Ps Pe Pi Pf every script's opening/closing brackets and quotation marks: ( ) [ ] { }
//                 " " ' ' « » 「 」 （ ）. Categories rather than a literal list, so CJK and
//                 other scripts' brackets are covered without maintenance.
//   - , ; ! ?     sentence and list punctuation, plus the fullwidth and CJK equivalents
//                 。 、 ， ； ！ ？ and the ellipsis.
//   - ' " `       apostrophe and the two quote delimiters this grammar recognizes, so
//                 "report.pdf's" and a rejected quoted span still yield the bare name.
//   - * | < >     markdown emphasis, table cells and angle-bracketed names.
//   - — – ― ‒     the typographic dashes. NOT the ASCII hyphen, which is a NAME character.
// A trailing "." is handled separately (see NAME_RUN_END): it is a boundary only when what
// follows it is one too, so "report.pdf." ends a sentence while "2024.pdf.chunk3" is one
// token.
//
// Deliberately absent, each one a case the final review measured leaking a fragment:
// ":" ("ns:chapter.pdf"), "/" ("sub/chapter.pdf"), "%" ("doc%20name.pdf"), "+", "@", "#",
// "=", "&", "\", and every format control such as ZWNJ.
const NAME_BOUNDARY =
  String.raw`\s\p{Ps}\p{Pe}\p{Pi}\p{Pf},;!?'"*|<>` + "`" + String.raw`…—–―‒。、，；！？`;

// Zero-width guards: a bare match must be a STANDALONE token - a boundary (or the edge of
// the text) on each side. Both are lookarounds, so neither consumes a character and the
// matched span is still exactly the name.
//
// The start guard doubles as the cost bound. Without it every position inside a long run of
// name characters was tried as a match start, each one re-scanning the rest of the run,
// which made the pass quadratic in the run length - a denial of service on input this tool
// does not control, since a model writes the draft. Measured on a 20k-character run:
// 22s -> 4ms (non-ASCII), 983ms -> 4ms (ASCII); pinned by the timing tests in
// test/grammar.test.ts.
//
// The end guard skips a run of "." and ":" before testing, because either can be punctuation
// or a continuation depending on what comes next. Followed by a boundary or the end of the
// text it is punctuation ("The source is report.pdf.", "report.pdf: the figures are on p.5");
// followed by anything else it continues an identifier ("2024.pdf.chunk3"), which is exactly
// the rule the bracket-tag path already applied to the same strings. The skip is deliberately
// one-sided: a LEADING ":" is a continuation unconditionally, because that is the position
// where a namespaced id puts it ("ns:chapter.pdf") and where reading the tail as a document
// invents a name the author never wrote.
const NAME_RUN_START = String.raw`(?:^|(?<=[${NAME_BOUNDARY}]))`;
const NAME_RUN_END = String.raw`(?=[.:]*(?:[${NAME_BOUNDARY}]|$))`;

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
const DOC_NAME_PATTERN = String.raw`${NAME_RUN_START}(?:${NAME_OR_DOT_CHAR})*(?:${NAME_CHAR})\.${PDF_EXT}${NAME_RUN_END}`;

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
// name. Three conditions must hold:
//   - matches RE_FILE_NAME_SHAPE (extension case-insensitive), i.e. starts with a real
//     character, contains only name-shaped characters and spaces, and has no
//     leading/trailing whitespace inside the delimiters (enforced by the anchors).
//     Unicode-aware, matching the bare name class - an ASCII-only shape test would reject
//     every non-ASCII name and silently push it back to the bare pass, which is exactly the
//     fragment path this round removed.
//   - at most MAX_DELIMITED_NAME_WORDS space-separated words
//   - at most MAX_DELIMITED_NAME_CHARS characters
//
// Review-finding rework: the three ways of failing those conditions are NOT interchangeable,
// and treating them alike is what let a rejected span leak a fragment of the name the author
// actually wrote. Measured before the fix: `"_internal draft.pdf"` was checked as
// `draft.pdf`, `"A B C D E.pdf"` as `E.pdf` - a `resolved` verdict on a DIFFERENT real
// document, which is worse than either outcome the rest of this grammar trades off (a false
// `unresolved` is at least visible; a silence is recoverable by quoting). So the verdict is
// three-valued and each branch is handled differently at the call site:
//
//   "name"       - accept it.
//   "over-cap"   - name-shaped in its characters, so this IS one name the author wrote; it is
//                  merely longer or wordier than this grammar will vouch for. RESERVE the
//                  span and emit nothing: silence, never a fragment.
//   "not-a-name" - carries a character a file name in this grammar cannot hold, so it is
//                  prose. Treated as if it were never quoted at all - NOT added to
//                  quotedSpans, so a real bare name inside it (`"the data comes from
//                  report.pdf"`) still surfaces. Removing this is what turned an over-match
//                  into a deleted valid citation in the probe that prompted the earlier
//                  round, so it stays.
const MAX_DELIMITED_NAME_CHARS = 80;
const MAX_DELIMITED_NAME_WORDS = 4;

// A leading `_`, `-` or `.` is legal in a real file name (and is already legal in the BARE
// pattern), so rejecting it made `"_internal draft.pdf"` fall through and be read as
// `draft.pdf`. It is admitted here, but ONLY when bound directly to a letter or digit: a
// punctuation mark followed by a space is prose decoration, not a name, and admitting it
// would turn a quoted list bullet (`"- report.pdf"`) or an elision (`"... report.pdf"`) into
// an invented document name and a false `unresolved` - the mirror of the defect this fixes.
// One such character, not a run, for the same reason.
const RE_FILE_NAME_SHAPE = new RegExp(
  String.raw`^[_\-.]?[\p{L}\p{N}][${NAME_CHARS} .]*\.${PDF_EXT}$`,
  "u",
);

type DelimitedNameVerdict = "name" | "over-cap" | "not-a-name";

// The two caps are NOT interchangeable, and this is the load-bearing asymmetry:
//
//   - Over the WORD cap is indistinguishable from prose. `"the data comes from report.pdf"`
//     and `"A B C D E.pdf"` are both five words of letters and spaces; nothing structural
//     separates a wordy file name from an ordinary quoted sentence that happens to mention
//     one. Reserving the span would silence the real bare name inside every such quotation,
//     which is the defect the earlier round fixed, so it keeps falling through. The fragment
//     this can still leak is disclosed in all three user-facing surfaces.
//   - Over the CHARACTER cap while WITHIN the word cap is not prose: four words cannot fill
//     80 characters of ordinary English. It is one very long name, so the span is reserved
//     and nothing is emitted - silence instead of the name's tail read as a different
//     document.
//
// Hence the word cap is checked first and answers "not-a-name", and only the character cap
// answers "over-cap". The character-class test runs before both, because an over-length span
// still has to be recognized as name-shaped for that distinction to exist at all.
function classifyDelimitedName(content: string): DelimitedNameVerdict {
  if (content.length === 0) return "not-a-name";
  if (!RE_FILE_NAME_SHAPE.test(content)) return "not-a-name";
  const words = content.split(" ").filter((w) => w.length > 0);
  if (words.length > MAX_DELIMITED_NAME_WORDS) return "not-a-name";
  if (content.length > MAX_DELIMITED_NAME_CHARS) return "over-cap";
  return "name";
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

// Answers "is the run of URL characters immediately before position i one that contains
// '://'?" for every position at once, in a single left-to-right pass.
//
// This used to be a backward scan per match, and it was the third quadratic in this file:
// "," and "/" and every letter continue a URL run, so a comma-separated source list with no
// whitespace in it - "Sources: a.pdf,b.pdf,c.pdf,..." - made every match re-scan the whole
// preceding draft, one regex test per character. Measured on a 96 KB draft: 8206 ms, growing
// 4x per doubling, versus 8 ms with the function stubbed out. The text is untrusted, so cost
// has to stay linear in it.
//
// flags[i] is 1 when the maximal run of URL characters ending at i-1 contains "://". The
// recurrence is exact: a run either continues (inherit the previous position's answer, or
// set it if "://" ends right here) or is broken by a non-URL character (answer 0). ":" and
// "/" are themselves URL characters, so a "://" is always wholly inside the run it marks.
// Texts with no "://" anywhere - the overwhelming majority - skip the pass entirely.
function urlSchemeFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length + 1);
  if (!text.includes("://")) return flags;
  for (let i = 1; i <= text.length; i++) {
    const ch = text[i - 1];
    // Non-global regex: `.test` carries no lastIndex state, so this is safe to call in a loop.
    if (!RE_URL_RUN_CHAR.test(ch)) continue; // run broken: flags[i] stays 0
    const schemeEndsHere = ch === "/" && text[i - 2] === "/" && text[i - 3] === ":";
    flags[i] = flags[i - 1] === 1 || schemeEndsHere ? 1 : 0;
  }
  return flags;
}

function isUrlPrefixed(urlScheme: Uint8Array, start: number): boolean {
  return urlScheme[start] === 1;
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
// separator itself from spanning an intervening document mention: "a.pdf and b.pdf on page
// 5" fails to match starting at "a.pdf" (the mandatory whitespace right after a connector
// attempt can't reach past "and", which isn't in the list), so it can only match starting
// at "b.pdf".
//
// That is NOT the same guarantee as "the page belongs to the document on the left", and an
// audit found the gap: nothing between "methods.pdf" and "page 12" in "methods.pdf, page 12
// of results.pdf" is a document name, so the separator matched and the page bound to the
// WRONG document. See PAGE_OWNER_PREPOSITION below for the guard that closes it - the
// separator rule alone never could, because the evidence sits on the far side of the page
// number.
const CONNECTOR_WORD = String.raw`\b(?:${ci("on")}|${ci("at")}|${ci("see")})\b`;
const OPEN_BRACKET = String.raw`[(\[]`;
const CLOSE_BRACKET = String.raw`[)\]]?`;
const DOC_PAGE_SEP = String.raw`(?:[,;]?[ \t]*(?:${CONNECTOR_WORD}[ \t]+)?|[ \t]*${OPEN_BRACKET}[ \t]*)`;

// Audit fix (Critical): a page phrase can name the document it belongs to, and when it does,
// that document is the owner - not whatever name happens to sit to its left. "methods.pdf,
// see page 12 of results.pdf" used to report `methods.pdf#p12`, which is the worst shape of
// failure this tool has: if methods.pdf is shorter than 12 pages the citation comes back
// `unresolved` carrying a NON-NULL `title` - the machine-readable "this document is real,
// fix the page" signal (CLAUDE.md hard rule 4) - so a consuming agent corrupts a citation
// that was correct. The other half is the mirror image: the genuine page-12 claim about
// results.pdf was reported `resolved` with its page never checked, so a fabricated page
// number in the second document could not be caught at all.
//
// The fix DROPS the page rather than re-binding it forward. Binding forward would be a
// second, opposite guess in a position where the grammar has no evidence for either
// (docs/citation-grammar.md, "the allowlist direction": a false `unresolved` deletes correct
// work, a silence does not and is recoverable by rewriting the sentence). Both documents are
// still extracted and checked; only the page claim goes unverified, exactly as it already
// did for the connector this rule was measured against - "a.pdf and page 12 of b.pdf" has
// always dropped the page, and this makes "," and ";" agree with "and" instead of
// disagreeing with it.
//
// Re-review fix (Critical 2): the first version of this guard was a REGEX enumerating one
// spelling of the owner - `[ \t]+(of|in)[ \t]+` immediately followed by a bare or
// double-quote/backtick-quoted name. Every other ordinary rendering of the same sentence
// slipped past it and bound the page to the document on the LEFT again: "page 12 of THE
// results.pdf", "page 12 from results.pdf", an owner on the next line, a non-breaking space,
// `'results.pdf'`, `(results.pdf)`, `[results.pdf]`, `<results.pdf>`, `**results.pdf**`, and
// a range whose separator was not recognized ("pages 5-7" written with an em dash, where the
// page match ends before the owner phrase even begins). The single-quote case had the
// grammar disagreeing with itself: docs/citation-grammar.md states that `'report.pdf'` IS
// recognized and checked, because a single quote is an ordinary boundary character.
//
// Enumerating prepositions and quote styles is what failed twice, so this is now STRUCTURAL
// and decides from the bare pass's own verdict rather than re-deriving one. `docStarts`
// marks the start of every document the bare pass accepted, so "is a document named just
// after this page phrase" is a mask lookup - the same technique namesStandaloneDoc uses, and
// for the same reason: two implementations of "is this a document name" is how the last
// version came to disagree with the rest of the file.
//
// The probe walks forward from the end of the page match and answers "is this page phrase
// plausibly followed by the name of the document it belongs to". It steps over:
//   - whitespace of every kind, U+00A0 and a line break included;
//   - DECORATION: brackets and quotation marks of every script (Ps/Pe/Pi/Pf), every dash
//     (Pd - which is also what carries an unrecognized range separator past the probe),
//     `"`, `'`, a backtick, and the emphasis and angle marks `*`, `~`, `<` and `>`;
//   - at most MAX_CONNECTING_WORDS connecting words.
// It answers YES on reaching a document start, and NO on anything else - a digit-and-letter
// word budget exceeded, or any character that is neither decoration nor a word: `,` `;` `.`
// `:` `!` `?` all end the probe, which is what keeps "page 3 of 40.", "page 12 of the
// appendix." and a comma-separated source list binding exactly as before.
//
// Three deliberate refusals, each protecting a shape where binding LEFT is correct:
//   - `and` and `or` end the probe. They coordinate two separate items ("methods.pdf p.3 and
//     results.pdf p.7"), where the page really does belong to the document on the left.
//     Note the direction of this list versus the one it replaces: an unforeseen word now
//     makes the probe DROP the page (a silence, recoverable by rewriting), where an
//     unforeseen preposition used to make it BIND the page to the wrong document (a false
//     `unresolved` carrying a non-null `title`, i.e. deleted or corrupted correct work).
//     That is the same allowlist-direction argument the boundary rule is built on, applied
//     to the failure that matters here.
//   - a line break before the first connecting word ends the probe, so the connecting phrase
//     must BEGIN on the page's own line. This is what keeps a bulleted or numbered list of
//     citations - the commonest shape an agent writes - from losing every page it states,
//     while still following an owner phrase that merely wraps ("page 12 of\nresults.pdf").
//   - a word budget of MAX_CONNECTING_WORDS, so an owner named far away down a sentence
//     ("...page 3 gives the model used to build results.pdf") still binds left.
// Each refusal is a place where the page can still bind to the wrong document; they are
// disclosed on all three user-facing surfaces rather than left implicit.
//
// A `://` reached by the probe answers YES: the page phrase does name its owner, in a form
// this tool deliberately cannot look up (a URL's own path segment is invisible in every
// status), and binding the page left there would be the same false `unresolved` with nothing
// extracted that could compensate for it.
const MAX_CONNECTING_WORDS = 3;
const NON_OWNER_CONNECTORS = new Set(["and", "or"]);
const RE_CONNECTING_WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const RE_OWNER_DECORATION = /[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Pd}"'`*<>~]/u;
const RE_OWNER_SPACE = /\s/u;
const LINE_BREAKS = new Set(["\n", "\r", "\u2028", "\u2029"]);

function pageOwnerFollows(text: string, docStarts: Uint8Array, matchEnd: number): boolean {
  let i = matchEnd;
  let words = 0;
  while (i < text.length) {
    if (docStarts[i] === 1) return true;
    const ch = text[i];
    if (LINE_BREAKS.has(ch)) {
      if (words === 0) return false; // the owner phrase must start on the page's own line
      i++;
      continue;
    }
    if (RE_OWNER_SPACE.test(ch) || RE_OWNER_DECORATION.test(ch)) {
      i++;
      continue;
    }
    if (RE_CONNECTING_WORD_CHAR.test(ch)) {
      if (words === MAX_CONNECTING_WORDS) return false;
      let end = i;
      // A document match always starts at a boundary character, and no word character is
      // one, so no document can start inside this run - it is safe to consume whole.
      while (end < text.length && RE_CONNECTING_WORD_CHAR.test(text[end])) end++;
      if (NON_OWNER_CONNECTORS.has(text.slice(i, end).toLowerCase())) return false;
      words++;
      i = end;
      continue;
    }
    // An owner this tool cannot look up is still an owner (see above); anything else ends
    // the phrase and the page binds to the document on the left, as it always did.
    return text.startsWith("://", i);
  }
  return false;
}

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

// node_id: <id> or node_id=<id>. The id runs to the first BOUNDARY character, the same rule
// the bare document pattern uses, rather than a closed charset of its own. A closed charset
// was a hole in the dangerous direction: any character outside it ENDED the captured id, so
// the reserved span covered only a prefix and the bare pass then read the tail as a
// document. "node_id: ns:chapter.pdf" reported "chapter.pdf#nns" - a fabricated document
// name AND a fabricated node id in one `unresolved` token, i.e. a consuming agent deleting a
// citation that was unverifiable by construction. Sharing the boundary rule means the id
// this path captures and the token the bracket-tag path captures are the same characters,
// so the two syntaxes cannot disagree about the same id.
//
// "." and "/" are inside a run, so a trailing sentence dot is captured too;
// stripTrailingPunctuation below removes it. The reserved-span exclusion in extractCitations
// stops a ".pdf"-shaped substring INSIDE a node id from being separately read as a document
// - the id's own text must never synthesize a document, which is exactly the failure mode
// docs/spike-b-findings.md section 6 exists to prevent.
// The `u` flag is not optional here: NAME_BOUNDARY carries \p{...} property escapes, and
// without it they silently degrade to the literal characters "p", "P", "s", "{", "}", which
// would end an id at the first "s" it contains.
const RE_NODE_ID = new RegExp(String.raw`${NODE_ID_KEYWORD}[:=]\s*([^${NAME_BOUNDARY}]+)`, "gdu");

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
// Colon may have horizontal whitespace on either side; the value stops at the closing `]`,
// a newline, or a nested `[`, whichever comes first, so a stray unclosed "[" can never
// swallow unrelated later text.
//
// Audit fix (Important): `[` joined that list to bound the cost, and it is the same limit
// the other two already express. Without it an UNCLOSED "[word:" let the value run to the
// end of the line and then backtrack through the whole line looking for a "]" that cannot be
// there - once per "[" in the text, so a line of them was quadratic. Measured on
// "[word: " * k: 109 ms at 4k, 429 ms at 8k, 1702 ms at 16k, 6.8 s at 32k, 27 s at 64k,
// growing 4x per doubling on text this tool does not control. With "[" ending the run, each
// "[" scans only as far as the next one, and those stretches are disjoint, so the pass is
// linear; pinned by the timing test in test/grammar.test.ts.
//
// The behavioural cost is disclosed in all three user-facing surfaces: a tag whose value
// contains a "[" is no longer recognized as a tag, so it reports nothing where it used to
// report an opaque `unchecked` id ("[node: abc[1]]"). That direction is the safe one under
// CLAUDE.md hard rule 4 - an entry moves from `unchecked` to silence, never towards
// `unresolved` - and it costs no real citation its check: the document scan reads the whole
// text regardless of brackets, so a `<name>.pdf` written inside such a tag is still
// extracted exactly as it would be in prose.
//
// Re-review fix (Critical 1): bounding the VALUE class was only half the cost fix, and the
// comment above used to claim the whole of it. The `[ \t]*` between the colon and the value
// is a second unbounded quantifier, and its character set OVERLAPPED the value class - both
// matched space and tab - so on an UNCLOSED tag the engine gave back one whitespace
// character at a time and re-scanned the entire remaining value looking for a "]" that
// cannot be there. Measured through extractCitations on "[node: " + " "*k + "x": 36 ms at
// 8k, 143 ms at 16k, 563 ms at 32k, 2215 ms at 64k, 8880 ms at 128k - still 4x per
// doubling, with tabs identical and the same length CLOSED costing 1.4 ms.
//
// Forbidding the value's FIRST character from being horizontal whitespace removes the
// overlap: after the greedy `[ \t]*` gives back one position the value's first character
// class immediately fails on the whitespace it handed back, so each give-back costs O(1)
// instead of re-scanning the tail. Reported output is unchanged - extractCitations trims the
// value before using it, so a leading space was never part of any id - and the reserved span
// merely no longer covers leading whitespace, which no document match can start inside.
// Verified by differential fuzzing against the previous pattern (see the report) and pinned
// by a timing test built on a whitespace RUN; the pre-existing bracket-tag timing test uses
// one space per tag and provably cannot reach this shape.
const RE_BRACKET_TAG = /\[[A-Za-z]+[ \t]*:[ \t]*([^[\]\n \t][^[\]\n]*)\]/gd;

// True when an identifier's own span - a bracket tag's value, or a node_id: id - contains a
// document name that the bare pass has ALREADY accepted as a standalone token of the
// surrounding text. Both identifier paths use it to decide whether to step aside and let the
// ordinary document/page/node scans read the real citation out of their own characters,
// instead of reserving the span and reporting a synthetic "node_id:<value>" token.
//
// The decision has to be the bare pass's own answer, not a re-derivation of it, and that is
// what the mask gives: `docStarts` marks the start of every match the bare pass accepted, so
// "does an accepted document start inside this span" is one lookup and cannot drift from
// what the bare pass will actually do. The earlier version re-ran the document regex over
// the value as an isolated STRING and applied its own boundary test to it - two
// reimplementations of one rule, which is how they came to disagree in the first place, and
// which would disagree again here: a value evaluated in isolation has the start of the text
// as its left neighbour, so "[node:report.pdf]" would step aside on the strength of a match
// the bare pass rejects (its real left neighbour is the tag's ":"), and the citation would
// vanish from every status. Deciding both from one mask makes that class of drift
// unrepresentable.
//
// A match starting inside the span also ENDS inside it: "]" and every other delimiter that
// closes such a span is a boundary character, which no name may contain.
//
// Both directions of the decision matter, and they fail differently:
//   - stepping aside when the value is NOT a document lets a fragment of a host-invented
//     slug ("sub/chapter.pdf" -> "chapter.pdf") be checked and reported `unresolved`, which
//     deletes a citation that was unverifiable by construction;
//   - refusing to step aside when it IS one hides a possibly fabricated document behind
//     docName: null, where the consuming agent's "keep every unchecked citation" policy
//     preserves it unchecked forever.
function namesStandaloneDoc(docStarts: Uint8Array, start: number, end: number): boolean {
  return docStarts.subarray(start, end).indexOf(1) !== -1;
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
// node_id: 0003.") is a real sentence end and must still split. The branches below are
// arranged so the carve-out can only ever suppress a boundary in the one case it targets,
// never invent one elsewhere:
//   1. `\b[Pp][Pp]?\.` NOT followed by a digit -> IS a boundary in its own right (closes
//      the gap: a sentence that happens to end in "p."/"pp." with no page number after it).
//   2. a run of two or more `.!?` that STARTS right after "p"/"pp" -> a boundary: only the
//      first character of such a run is suppressed by the carve-out, so "report.pdf p.. "
//      and "p?? " still end a sentence.
//   3. any other `.!?` run -> the general case.
//
// Audit fix (Important): every run branch is anchored at the START of its run by
// `(?<![.!?])`, and that lookbehind is a cost bound, not a rule. The run branch requires
// whitespace or end-of-text after the run, so on a run followed by anything else - the dot
// leaders of a pasted PDF table of contents, "Chapter 1.........12", which is exactly the
// kind of text this tool is fed - the engine used to backtrack through the whole run at
// EVERY starting position inside it. Measured: 123 ms at 8k dots, 438 ms at 16k, 1781 ms at
// 32k, growing 4x per doubling on input a model writes and a host passes straight through.
// Anchoring makes each run cost one backtrack sweep instead of one per character, and the
// sweeps are disjoint, so the pass is linear in the text; pinned by the timing test in
// test/grammar.test.ts.
//
// The anchoring is why branch 2 exists at all. The whole matched span used to be allowed to
// start one character INTO a run when the carve-out lookbehinds rejected its first
// character; anchored, that escape hatch is gone, so the same case is stated directly as its
// own branch. sentenceBoundaries reads only `index + length`, so a branch that starts
// earlier but ends in the same place is the same boundary. Verified equivalent to the
// unanchored pattern by differential fuzzing over random strings of `.!?pP`, whitespace,
// digits and letters: identical boundary positions on every one.
const RE_SENTENCE_BOUNDARY =
  /\b[Pp][Pp]?\.(?![ \t]*\d)(?:\s+|\s*$)|(?<![.!?])(?:(?<=\b[Pp])|(?<=\b[Pp][Pp]))[.!?]{2,}(?:\s+|\s*$)|(?<![.!?])(?<!\b[Pp])(?<!\b[Pp][Pp])[.!?]+(?:\s+|\s*$)|\n+/g;

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
// `bounds` is strictly increasing (matchAll yields non-overlapping matches in order), so
// this binary searches rather than scanning. The linear scan was the innermost of three
// nested loops in the node-binding pass below and turned it cubic; see that pass for the
// measurement.
function sentenceIndexAt(bounds: number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  const urlScheme = urlSchemeFlags(text);

  // The bare document scan runs FIRST, before anything reserves a span, because both
  // identifier paths below have to consult its verdict (see namesStandaloneDoc): whether a
  // tag's value or a node id names a document is exactly the question "would the bare pass
  // accept a document starting inside these characters", and there must be one answer to it.
  // Reserved spans are applied afterwards, when these matches are turned into mentions.
  const docMatches: { start: number; end: number; full: string }[] = [];
  const docStarts = new Uint8Array(text.length);
  for (const m of text.matchAll(RE_DOC)) {
    const start = m.index ?? 0;
    // Defect 1: a URL's own path segment is not a citable document. Applied here rather than
    // at mention time so the identifier paths see the same verdict.
    if (isUrlPrefixed(urlScheme, start)) continue;
    docMatches.push({ start, end: start + m[0].length, full: m[0] });
    docStarts[start] = 1;
  }

  // Identifier-like citations next (node_id: and the generic bracket tag): their own matched
  // span is a reserved span that the document mentions below must never be read out of
  // (Important 6) - "node_id: sub/chapter.pdf" must not let "chapter.pdf" be discovered as a
  // document, and neither must "[node: sub/chapter.pdf]".
  const nodeMentions: NodeMention[] = [];
  const idSpans = new Uint8Array(text.length);
  for (const m of text.matchAll(RE_NODE_ID)) {
    const start = m.index ?? 0;
    // `d` flag: exact span of the captured id group (group 1), not the whole
    // "node_id: ..." match - a document mentioned before the keyword must stay readable.
    const groupSpan = m.indices?.[1];
    // Step aside when the id IS a standalone document name, exactly as the bracket-tag path
    // does below and for the same reason: "node_id: invented-report.pdf" must be CHECKED and
    // reported `unresolved`, not hidden behind docName: null where the consuming agent's
    // keep-every-unchecked-citation policy would preserve a fabrication indefinitely. The
    // two paths name one id space, so a claim that they agree has to be true of every id,
    // not only of the ones neither of them checks.
    if (groupSpan && namesStandaloneDoc(docStarts, groupSpan[0], groupSpan[1])) continue;
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
    if (groupSpan && namesStandaloneDoc(docStarts, groupSpan[0], groupSpan[1])) continue;
    if (groupSpan) reserveSpan(idSpans, groupSpan[0], groupSpan[1]);
    instances.push({
      index: start,
      citation: { token: `node_id:${value}`, docName: null, pages: null, nodeId: value },
    });
  }

  // Quoted document mentions - preferred over a bare match covering the same span, but
  // ONLY when the delimited content is genuinely file-name-shaped (classifyDelimitedName).
  // Computed before bare mentions so an ACCEPTED span can be excluded from them; a span
  // rejected as PROSE contributes nothing here - not a docMention, not a reserved span - so
  // the bare match inside it (e.g. plain "report.pdf" inside an ordinary quotation) is
  // left completely free to be found in the bare pass below. An OVER-CAP span is the third
  // case and is handled the opposite way: reserved, so nothing at all comes out of it.
  const quotedPageByStart = new Map<number, { from: number; to: number }>();
  for (const m of text.matchAll(RE_QUOTED_DOC_PAGE)) {
    const start = m.index ?? 0;
    const name = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 1);
    const from = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 2);
    // Only an accepted name can carry a page. An over-cap span emits no document at all, so
    // there is nothing for a page to bind to; recording one here would be dead weight.
    if (name === undefined || from === undefined || classifyDelimitedName(name) !== "name") continue;
    // The page names its own document, which is not this one: drop the page (the quoted
    // name is still extracted by the pass below, just without it). See pageOwnerFollows.
    if (pageOwnerFollows(text, docStarts, start + m[0].length)) continue;
    const to = delimiterGroup(m, QUOTED_PAGE_GROUP_STRIDE, 3);
    quotedPageByStart.set(start, { from: Number(from), to: to !== undefined ? Number(to) : Number(from) });
  }

  const quotedSpans = new Uint8Array(text.length);
  const docMentions: DocMention[] = [];
  for (const m of text.matchAll(RE_QUOTED_DOC)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const full = delimiterGroup(m, QUOTED_DOC_GROUP_STRIDE, 1);
    if (full === undefined) continue;
    const verdict = classifyDelimitedName(full);
    // Prose: ignore the quote entirely, leaving any real bare name inside it to the bare pass.
    if (verdict === "not-a-name") continue;
    // One name, over the word or character cap. RESERVING is the whole point: without it the
    // bare pass matched the tail of the name the author wrote and checked it as a different
    // document (`"A B C D E.pdf"` was read as `E.pdf`). Nothing is emitted for this span in
    // any status - a silence the author can recover from by citing a shorter real name.
    if (verdict === "over-cap") {
      reserveSpan(quotedSpans, start, end);
      continue;
    }
    // Re-review fix (Minor 4): the URL exclusion used to be applied to the bare pass only,
    // so a URL's own path segment was still extracted whenever it happened to be delimited
    // ("https://example.com/`report.pdf`"). Both the README and the tool description state
    // flatly that a URL's path segment is not extracted in any status, so the quoted pass
    // has to honour the same rule. The span is still RESERVED (unlike a span rejected by
    // classifyDelimitedName as prose above): dropping it silently would leave the bare match
    // delimiters free to be picked up by the bare pass, where the delimiter itself now ends
    // the URL run - the exclusion would undo itself one pass later.
    if (isUrlPrefixed(urlScheme, start)) {
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
    const start = m.index ?? 0;
    // Same rule as the quoted pass above: a page phrase that names its OWN document binds to
    // neither, so the document here is emitted with no page rather than with the wrong one.
    if (pageOwnerFollows(text, docStarts, start + m[0].length)) continue;
    const from = Number(m[2]);
    const to = m[3] !== undefined ? Number(m[3]) : from;
    pageByStart.set(start, { from, to });
  }
  for (const { start, end, full } of docMatches) {
    if (overlapsReserved(idSpans, start, end) || overlapsReserved(quotedSpans, start, end)) continue;
    docMentions.push({ start, end, full, page: pageByStart.get(start) ?? null });
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

  // Documents indexed by sentence and sorted within it, so a node reaches its candidates by
  // two binary searches instead of a scan. The scan version was nodes x documents x
  // sentence-boundaries - cubic - on the most ordinary draft shape there is, one document and
  // one node per sentence: 11592 ms for a 100 KB draft carrying 3200 citations, growing ~8x
  // per doubling. `order` preserves each mention's position in docMentions, which is the
  // tie-break the scan used (first minimum wins) and must not silently change.
  const docsBySentence = new Map<number, { doc: DocMention; order: number }[]>();
  docMentions.forEach((doc, order) => {
    const sentence = sentenceIndexAt(bounds, doc.start);
    const group = docsBySentence.get(sentence);
    if (group) group.push({ doc, order });
    else docsBySentence.set(sentence, [{ doc, order }]);
  });
  for (const group of docsBySentence.values()) group.sort((a, b) => a.doc.start - b.doc.start);

  for (const node of nodeMentions) {
    const sentence = sentenceIndexAt(bounds, node.start);
    const group = docsBySentence.get(sentence) ?? [];
    // Two candidates are provably enough. Document mentions are disjoint and here sorted by
    // start, and a node mention can never begin inside one (a name contains no ":" or "=",
    // so "node_id:" cannot occur within a match). So for every mention entirely to the left
    // the distance is `node.start - end`, which strictly decreases towards the nearest one,
    // and for every mention to the right it is `start - node.start`, which strictly
    // increases: the minimum on each side is the immediate neighbour, and at most those two
    // can tie.
    let lo = 0;
    let hi = group.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (group[mid].doc.start <= node.start) lo = mid + 1;
      else hi = mid;
    }
    let nearest: DocMention | null = null;
    let nearestDistance = Infinity;
    let nearestOrder = Infinity;
    for (const index of [lo - 1, lo]) {
      const candidate = group[index];
      if (!candidate) continue;
      const { doc, order } = candidate;
      const distance = Math.min(Math.abs(doc.start - node.start), Math.abs(doc.end - node.start));
      if (distance < nearestDistance || (distance === nearestDistance && order < nearestOrder)) {
        nearest = doc;
        nearestDistance = distance;
        nearestOrder = order;
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
