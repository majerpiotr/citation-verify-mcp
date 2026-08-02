// test/server.test.ts
//
// Drives the real MCP server over InMemoryTransport with a real MCP Client and a fake
// DocLookup (docs/rework-plan.md "Target interfaces") - offline, no key, no network.
// Covers: tool registration and input schema, an end-to-end resolved+unresolved call, the
// unresolved-vs-unchecked invariant at THIS layer (CLAUDE.md hard rule 4 - a throw from the
// client must surface as `unchecked`, never `unresolved`), the `suggestion` field
// round-tripping, and the tool description's load-bearing clauses (docs/rework-plan.md Task
// R4) pinned by meaning-carrying regexes rather than a verbatim string pin.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { DocLookup, DocLookupResult } from "../src/pageindex-client.js";

interface FakeConfig {
  documents?: Record<string, DocLookupResult | "throw">;
}

function fakeClient(config: FakeConfig): DocLookup {
  return {
    async getDocument(docName) {
      const v = config.documents?.[docName];
      if (v === "throw") throw new Error("backend unavailable");
      if (v === undefined) throw new Error(`test fixture missing for getDocument("${docName}")`);
      return v;
    },
    async getNodeIds() {
      return new Set<string>();
    },
  };
}

async function connectedClient(client: DocLookup): Promise<Client> {
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: "test", version: "0.0.1" });
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

describe("createServer verify_citations tool", () => {
  it("registers the tool with a required text input", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tools = await mcpClient.listTools();
    const tool = tools.tools.find((t) => t.name === "verify_citations");
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(Object.keys(schema?.properties ?? {})).toContain("text");
    expect(schema?.required).toContain("text");
  });

  it("resolves an existing document and reports a fabricated one unresolved", async () => {
    const mcpClient = await connectedClient(
      fakeClient({
        documents: {
          "real-doc.pdf": { found: true, doc: { name: "real-doc.pdf", pageCount: 10 } },
          "fake-doc.pdf": { found: false, similar: [] },
        },
      }),
    );

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See real-doc.pdf for the numbers, but fake-doc.pdf is fabricated." },
    });

    // Assert isError falsy BEFORE parsing, so a genuine failure surfaces its real message
    // instead of a confusing JSON.parse error.
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.resolved).toBe(1);
    expect(parsed.unresolved).toEqual(["fake-doc.pdf"]);
    expect(parsed.unchecked).toEqual([]);
  });

  it("passes a backend throw through as unchecked, never unresolved", async () => {
    const mcpClient = await connectedClient(fakeClient({ documents: { "down-doc.pdf": "throw" } }));

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See down-doc.pdf for details." },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.unchecked).toEqual(["down-doc.pdf"]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.details[0].status).toBe("unchecked");
  });

  it("carries a near-miss suggestion through to the client", async () => {
    const mcpClient = await connectedClient(
      fakeClient({
        documents: {
          "near-miss.pdf": { found: false, similar: ["Near-Miss.pdf"] },
        },
      }),
    );

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See near-miss.pdf for details." },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.details[0].status).toBe("unresolved");
    expect(parsed.details[0].suggestion).toMatch(/Near-Miss\.pdf/);
  });

  // The description is the only in-band instruction a consuming agent ever gets. Every
  // assertion below targets a SINGLE load-bearing clause with wording that appears nowhere
  // else in the description - each one was mutation-tested individually (see
  // .superpowers/sdd/implementation-plan/r4-report.md) to confirm it actually discriminates:
  // deleting only the clause it guards fails that assertion while the rest stay green.
  // Traps specifically guarded against here:
  //   1. a clause restated more than once must have EVERY occurrence covered by wording
  //      specific enough that a single surviving occurrence can't save it (e.g. the
  //      "to"-range and page-shape assertions pin the literal example list, not a generic
  //      word like "recognized").
  //   2. the MCP-error "never AS `unresolved`" clause and the bare-node "never `unresolved`"
  //      clause are DIFFERENT sentences, pinned by two DIFFERENT regexes - a single
  //      `/never .?unresolved/i` regex silently matches only one of them.
  //   3. DELETION of a whole sentence must be caught even when every OTHER assertion still
  //      passes - every sentence in the description has at least one dedicated assertion,
  //      including the opening purpose sentence, the `unresolved` action imperative, the
  //      canonical-token lead-in, the "last space-free segment" bridge, and the field-list
  //      framing ("Returns JSON...", the `details` shape line).
  //   4. REWORDING that keeps every individually-pinned phrase intact but changes the
  //      MEANING is caught by pinning the CONJUNCTION, not its two halves separately (the
  //      quoting-rule "AND"), by pinning exact adjacency for a field's TYPE (`resolved` -
  //      a COUNT; - the semicolon must follow immediately, or an inserted qualifying phrase
  //      would contradict the C3 clause two sentences later), and by pinning the TRUE
  //      example text positively (the `unchecked` parenthetical) rather than banning one
  //      wrong wording with `.not.toMatch`.
  it("publishes a description carrying its load-bearing clauses", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const description = tool?.description ?? "";

    // --- opening purpose sentence: the only thing telling a host model when to call this
    // tool at all (Important 5) - pinned whole, so deleting it (not just a fragment) fails.
    expect(description).toMatch(
      /Deterministically checks, by code calling PageIndex \(the source of truth\), whether the citations in the given text resolve - never by asking a model, which could hallucinate like the citations it is checking\./,
    );

    // --- output shape framing (Important 5: these lines read as restating the JSON the
    // agent can already see, but their ABSENCE removes the field-type distinctions, so each
    // is still pinned) ---
    expect(description).toMatch(/Returns JSON in a text content block:/);
    // `resolved` is a bare COUNT - semicolon must follow immediately, so a rewording that
    // inserts a qualifier before it (e.g. "...fully verified end to end, page included")
    // cannot slip through.
    expect(description).toMatch(/`resolved`\s*-\s*a COUNT;/);
    // `unresolved` is an array of tokens, not a count - AND the gloss must not claim the
    // document itself is absent, because resolver.ts returns `unresolved` for a document
    // that IS present when only the cited page or node missed. Pinned as one conjunction
    // (the array type, the "not always a missing document" correction, and the pointer to
    // `suggestion` as the only thing that distinguishes them) so a rewording cannot restore
    // the old "confirmed absent from the corpus" reading while keeping the other pieces.
    expect(description).toMatch(
      /unresolved`?\s*-\s*an ARRAY of tokens whose miss was POSITIVELY established against the corpus, which does NOT always mean the document is missing: a document that IS present, cited with a page outside its real page count or a node absent from its outline, is `?unresolved`? too, with `?title`?\s*:?\s*`?null`? either way - only `?suggestion`? distinguishes the two/i,
    );
    // `unchecked` is an array too - the FULL example parenthetical is pinned positively
    // (not a `.not.toMatch` ban on one wrong wording), so swapping in a false cause like
    // "a missing credential" fails this instead of silently passing.
    expect(description).toMatch(
      /unchecked`?\s*-\s*an ARRAY of tokens the check could not run for \(e\.g\. a timeout or the backend being down\)/i,
    );
    expect(description).toMatch(/`details`\s*-\s*per citation `\{ token, status, title, suggestion \}`/);
    // `total` counts DISTINCT canonical TOKENS, not documents - re-citing the same token
    // collapses, but the same document with two different pages counts twice (Minor fix:
    // the previous wording claimed same-document collapse, which is false). The `total` -
    // lead-in is pinned together with the parenthetical so the two can't drift apart.
    expect(description).toMatch(
      /`total`\s*-\s*the count of DISTINCT recognized-shape citations \(identical citations collapse to one; different pages of the same document count separately\)/i,
    );
    // `suggestion` is described as something to act on, not just a field name - both of its
    // two forms (a near-miss name, OR an explanation of what could not be checked) are
    // pinned together, not just the first.
    expect(description).toMatch(
      /suggestion`? may carry a near-miss document name or an explanation of what could not be checked/i,
    );

    // --- Critical 3: a `resolved` verdict can carry an unverified page ---
    expect(description).toMatch(
      /should be acted on - including on a `?resolved`? verdict: when the backend reports no page count, a cited page is not bounds-checked and the citation can still resolve/i,
    );
    expect(description).toMatch(/the page itself was never verified/i);
    expect(description).toMatch(/cited page falls within the document's real page count, only when the backend reports one/i);
    expect(description).toMatch(/cited node id exists in the document's real outline/i);
    // The "What is verified:" lead-in and the document-existence clause - previously only
    // the page/node continuations above were pinned, leaving the document-existence claim
    // itself (and the header framing it) deletable.
    expect(description).toMatch(/What is verified: that the cited document exists;/);

    // --- the primary `unresolved` action directive (Important 5 named this explicitly -
    // `/do not delete them/i` below guards only the `unchecked` half of the pair) ---
    // The imperative is pinned TOGETHER with its exception: an `unresolved` whose
    // `suggestion` says the document exists and only the page or node missed must be
    // corrected, not deleted. Splitting these into two assertions would let the exception be
    // dropped while the imperative stayed green - the deletion harm this whole distinction
    // exists to prevent.
    expect(description).toMatch(
      /For each `unresolved` citation, remove the claim or replace it with a verified citation - unless `suggestion` says the document exists and only the page or node missed, in which case fix that instead\./,
    );
    // --- outage-safety imperatives - the reason clause ("the corpus was never consulted...")
    // is pinned together with "Do NOT remove", not just the trailing "do not delete them" ---
    expect(description).toMatch(
      /Do NOT remove `unchecked` citations - the corpus was never consulted for them and they may well be valid/,
    );
    expect(description).toMatch(/do not delete them/i);
    // MCP-error clause - the "if the call itself fails" trigger is pinned together with its
    // consequence, not just the back half ("never AS `unresolved`", distinct from the
    // bare-node "never `unresolved`" clause below, defect 1).
    expect(description).toMatch(
      /If the call itself fails, the tool returns an MCP error result instead of this JSON; treat every citation in the text as `?unchecked`? in that case, never as `?unresolved/i,
    );

    // --- Critical 1: hyphen, en dash, and spaced "to" are the accepted range separators;
    // any OTHER separator silently truncates rather than being ignored - "not checked" is
    // the reassuring but false reading, so the truncation clause is pinned separately from
    // the "no recognized form at all" clause, which genuinely is just skipped ---
    expect(description).toMatch(/A range needs a hyphen, en dash, or spaced "to"/);
    expect(description).toMatch(
      /any other separator \(e\.g\. an em dash\) silently truncates to the first page instead of the range/i,
    );
    expect(description).toMatch(/a page in no recognized form at all is simply not checked/i);
    // The base recognized shape - a bare document citation - was previously assumed covered
    // by neighbouring assertions but had no dedicated pin of its own.
    expect(description).toMatch(/a document written as `<name>\.pdf`/);
    // The "Recognized citation shapes" lead-in is what frames the block below it as the
    // EXHAUSTIVE list; without it nothing tells a consuming model that a shape absent from
    // the list is simply not checked. Pinned together with the `.pdf`-only rule, which the
    // description never stated at all even though the grammar enforces it.
    expect(description).toMatch(
      /Recognized citation shapes - the list below is exhaustive, and `\.pdf` is the ONLY recognized extension \(a name ending in any other, e\.g\. `report\.docx`, is not extracted at all\)/,
    );
    // "rewrite it in a recognized form and call again" - the concrete instruction half of
    // the `total: 0` guard, previously left unpinned even though the guard itself (further
    // below) was.
    expect(description).toMatch(/rewrite it in a recognized form and call again/i);

    // --- recognized shapes, pinned to the literal example list (a generic word like
    // "recognized" can be satisfied elsewhere, so this pins the actual examples) ---
    expect(description).toMatch(/`p\.5`, `pp\. 5-7`, `page 12`, `pages 5 to 7`/);
    // node_id with both separators documented (Minor).
    expect(description).toMatch(/`node_id: <id>`? or `?node_id=<id>`/);
    // page/node keywords are case-insensitive; the document name is not (Minor + existing).
    expect(description).toMatch(/page and node keywords case-insensitive/i);
    expect(description).toMatch(/matched CASE-SENSITIVELY/);

    // --- Critical 2: the accepted same-line forms (now shared by quoted AND bare names -
    // no exception is stated, because none exists in the current grammar). The "glued
    // directly" and comma/semicolon forms are pinned together with the connector-word form,
    // not just the newer connector/bracket additions. ---
    expect(description).toMatch(
      /either glued directly, after `,`\/`;`, after a connector \(`on`\/`at`\/`see`\)/,
    );
    expect(description).toMatch(/inside `\(\)`\/`\[\]`/);
    expect(description).toMatch(/on the SAME LINE, with no other document name in between/i);

    // --- final-fix Fix 1: node binding is NOT governed by the page separator rule above -
    // a node binds to the nearest document mention anywhere in the SAME SENTENCE, either
    // order, with no separator constraint at all. Pinned as one conjunction (not "nearest"
    // and "no separator constraint" separately) so a rewording that keeps one true fragment
    // while reintroducing a same-line-only or separator requirement still fails. The
    // practical-advice half (separate sentences when the nearest mention is wrong) is
    // pinned on its own, since a rewording could state the rule correctly but drop the
    // guidance that makes it actionable. ---
    expect(description).toMatch(
      /`node_id: <id>`? or `?node_id=<id>`? binds instead to the NEAREST document mention anywhere in the SAME SENTENCE, either order, with no separator constraint at all/i,
    );
    expect(description).toMatch(/if the nearest is the wrong one, use separate sentences/i);

    // --- final-fix Fix 4a: a bare match that is a URL's own path segment is invisible
    // (commit 776cfdc) - pinned together with "not resolved, unresolved, or unchecked" so a
    // rewording can't silently reclassify it as one of the three real statuses. The
    // deliberately-uncovered scheme-relative/bare-host half is pinned separately and
    // positively (the exact examples), since THAT half is what still produces a false
    // `unresolved` and is the one a consuming agent most needs to see. ---
    // The boundary is no longer "whitespace" (grammar.ts RE_URL_RUN_CHAR): the run ends at
    // the first character a URL cannot contain, and the exclusion now covers a quoted or
    // backtick-delimited match too. Pinned as one conjunction so neither the widened
    // boundary nor the quoted coverage can be dropped while the other survives.
    expect(description).toMatch(
      /A match after a same-line `:\/\/` is invisible - not resolved, unresolved, or unchecked - while nothing between them could have ended the URL \(the run ends at the first character a URL cannot contain[^)]*\), and this covers a quoted or backtick-delimited match too/i,
    );
    // The accepted silence: a URL sub-delimiter does NOT end the run, so a citation glued to
    // a URL by one is absent from every status. An accepted gap must be a disclosed gap.
    expect(description).toMatch(
      /A character a URL path MAY contain \(`,`, `;`, `\(`, `\)`\) does NOT end it, so a citation glued to a URL by one of those is dropped in EVERY status - absent from the output entirely, which looks identical to there being nothing to check/i,
    );
    expect(description).toMatch(
      /scheme-relative \(`\/\/host\/doc\.pdf`\) and bare-host \(`host\/doc\.pdf`\) forms are NOT covered and are still read as document names, risking a false `unresolved`/i,
    );

    // --- final-fix Fix 4b: a bracket-tag value is no longer unconditionally `unchecked`
    // (commit 776cfdc) - a document-shaped value is extracted and checked like prose,
    // including any page/node cited alongside it in the same brackets. Pinned as three
    // pieces: the conditional trigger, the extraction consequence (page/node included -
    // this is the part that actually changed), and the non-document-shaped fallback -
    // dropping any one of the three would silently reintroduce the old, now-false
    // "always unchecked" claim. ---
    // "names a real `<name>.pdf`" alone is no longer true: the name must stand as its own
    // token, not be glued into a longer identifier (grammar.ts containsStandaloneDocName), so
    // the STANDALONE qualifier is pinned inside the same regex as the trigger.
    expect(description).toMatch(
      /`\[node:<id>\]` or `\[<word>:<id>\]` - is `unchecked` UNLESS its value names a real `<name>\.pdf` as a STANDALONE token \(not glued into a longer identifier: `\[node: sub\/chapter\.pdf\]`, `\[node: v1\.pdf-part2\]` and `\[node: report\.pdfx\]` stay `unchecked`\)/,
    );
    expect(description).toMatch(
      /then that document \(and any page\/node cited alongside it\) is checked as in prose/i,
    );
    expect(description).toMatch(
      /otherwise it stays a standalone `unchecked` id, never bound to any document \(id space unconfirmed\)/i,
    );
    expect(description).toMatch(/cite the real `<name>\.pdf` for a verdict/i);
    // The old claim ("a URL-valued tag is not a citation at all") is false: the `://` check
    // makes the TAG step aside, reserving nothing, so any document-shaped token elsewhere
    // inside the same brackets is read by the ordinary passes and can come back
    // `unresolved` - which would make a consuming agent delete a valid web citation. The
    // measured example and the "map it back before deleting" instruction are pinned together
    // with the rule, because the rule without them reads as reassurance.
    expect(description).toMatch(
      /A tag whose value contains `:\/\/` is not reported as an id at all, but that silences only the TAG: a `<name>\.pdf` inside the same brackets that is not itself part of the URL \(`\[Source: Annual Overview report\.pdf - https:\/\/example\.com\/post\]` yields `report\.pdf`\) is still read as an ordinary document citation and can come back `unresolved` - map it back to the bracket before deleting anything, since the citation there may be a valid web reference/,
    );

    // --- quoting rule: the CONJUNCTION is what carries the meaning, not its two halves -
    // pinning only "double quotes or backticks" and only "file-name-shaped" separately
    // would still pass a rewording that splits this into two sentences and drops the "AND"
    // (i.e. "quoting alone suffices"), so the joined phrase is pinned as one unit, together
    // with its trigger condition ("a name containing spaces") ---
    expect(description).toMatch(
      /A name containing spaces must be wrapped in double quotes or backticks AND be file-name-shaped/i,
    );
    // The allowed-character set (not a forbidden-character list, which reads as exhaustive
    // but omits `(`, `)`, `+`, `/`, `#`, etc. - Minor fix). The set is now Unicode-aware
    // (grammar.ts NAME_CHARS) and the FIRST character must be a letter or digit
    // (RE_FILE_NAME_SHAPE), which the old wording omitted - pinned as one conjunction with
    // the word/character limits so the leading-character rule cannot rot out again.
    expect(description).toMatch(
      /file-name-shaped \(at most 4 words, 80 characters, beginning with a letter or digit, and otherwise only letters\/digits\/spaces\/dots\/underscores\/hyphens - letters and digits of ANY script count\)/i,
    );
    // The leading-character rule differs between the quoted and unquoted paths, and the
    // consequence is a silently different document - pinned with its measured example.
    expect(description).toMatch(
      /A leading `_`, `\.` or `-` fails the shape check even though it is legal inside an UNQUOTED name, so `"_internal draft\.pdf"` is read as `draft\.pdf`/,
    );
    // Containment for the Unicode widening: a BARE name in a script with no word spaces is
    // not extracted at all, and quoting is the supported route for it. Undisclosed until now.
    expect(description).toMatch(
      /A BARE name written in a script that does not separate words with spaces \(Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan\) is not extracted at all \(`total: 0`\); quote it to have it checked/,
    );
    expect(description).toMatch(/Single quotes are NOT a delimiter/i);

    // --- final-fix Fix 2: the fallback for a name with a disallowed character (quoted or
    // not) is NOT reliably "last space-free segment" - measured behavior showed it can also
    // be dropped entirely (`total: 0`) or truncated mid-word into a fragment that is not the
    // last segment, and quoting does not rescue a name with such a character. Pinned as one
    // conjunction covering "quoting does not rescue", "drop the match entirely", AND
    // "not-necessarily-last fragment" together, so a rewording that restores only the old
    // (false) "last segment" guarantee still fails even if it keeps the other true pieces. ---
    expect(description).toMatch(
      /quoting does not rescue any other character, which may instead drop the match entirely \(`total: 0`\) or leave a shorter, not-necessarily-last fragment read as a DIFFERENT document/i,
    );
    expect(description).toMatch(/check `?title`? on a `?resolved`? verdict to catch this/i);

    // --- final-fix Fix 3: the previously-undisclosed trade-off that a quoted/backtick span
    // is read as a document name even inside inline code, so a code example naming an
    // unrelated file can wrongly report `unresolved`. ---
    expect(description).toMatch(
      /A quoted span of up to 4 words ending in `\.pdf` is read as a document name even inside inline code, so a shell example can report `unresolved`/i,
    );

    // --- bare node_id rule - the trigger condition ("with no document in the same
    // sentence") is pinned together with the verdict, not just the verdict half ---
    expect(description).toMatch(
      /A bare `?node_id:`? with no document in the same sentence is reported `?unchecked`?, never `?unresolved`? - node numbering is per-document/i,
    );
    expect(description).toMatch(/node id alone identifies nothing/i);

    // --- the false-assurance guard. Pinned as the WHOLE conjunction: the previous regex
    // bound only the "not a clean bill of health" half, which is exactly why the other half
    // ("NOT that the text is free of citations" - Spike A's actual finding, and the one
    // CLAUDE.md forbids softening) could be deleted with the suite staying green. Both NOTs
    // are pinned in one expression so neither can rot out alone. ---
    expect(description).toMatch(
      /`?total: 0`? means no citation of a recognized shape was found - NOT that the text is free of citations, and NOT a clean bill of health/,
    );
    // --- combined page+node citation returns one verdict, AND its consequence (which half
    // failed is only knowable from `suggestion`) - pinned as one unit, not just the first
    // half ---
    expect(description).toMatch(
      /carrying both a page and a node returns ONE verdict, so an `?unresolved`? there may mean either half failed - `?suggestion`? says which/i,
    );

    // --- Important 4: the canonical token shape, so an agent can map a token back to its
    // own draft, and can tell "page checked" from "page dropped" - the `token` subject and
    // the final "map it back" instruction are pinned together with the shape grammar, not
    // left as unpinned lead-in/trailer text ---
    expect(description).toMatch(
      /`token` \(and each `unresolved`\/`unchecked` entry\) is a canonical form, not verbatim text/i,
    );
    expect(description).toMatch(/`<document>` plus optional `#p<page-or-range>`/);
    expect(description).toMatch(
      /`#n<node-id>`, `&n<node-id>` after a page, or bare `node_id:<id>`\) - map it back to your draft before acting\./,
    );
  });

  it("gives the text parameter a description", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const schema = tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
    expect(schema?.properties?.["text"]?.description).toMatch(/draft text/i);
  });
});

// CLAUDE.md used to tell a future agent that the disclosed limits "are pinned by assertions
// in test/server.test.ts, which will fail if you do not [update both]". That was true of the
// tool description and FALSE of the README: nothing in the suite read README.md, so a stale
// README shipped green - which is exactly how the `total: 0` clause came to say one thing in
// the description and another in the README.
//
// This closes that hole for SUBSTANCE only, deliberately not for formatting. Each assertion
// below names a claim whose absence would mislead a human operator about what the code does,
// and each has a counterpart assertion against the live tool description above, so the two
// documents cannot drift on it. Wording, ordering, section layout and prose style are NOT
// pinned: a rewrite that keeps every claim true stays green.
describe("README states the load-bearing claims the tool description states", () => {
  // Whitespace is collapsed before matching: the README is hard-wrapped, so any claim long
  // enough to matter spans a line break, and pinning the break positions would make this a
  // formatting test - re-wrapping a paragraph would fail it while every claim stayed true.
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8").replace(/\s+/g, " ");

  it("carries both halves of the `total: 0` guard", () => {
    expect(readme).toMatch(
      /`?total: 0`? means no citation of a recognized shape was found[^.]*- it is not a clean bill of health, and not proof the text has no citations/i,
    );
  });

  it("says an `unresolved` verdict does not always mean a missing document", () => {
    expect(readme).toMatch(/`unresolved` does not always mean the document is missing/i);
    expect(readme).toMatch(/only `suggestion` distinguishes/i);
  });

  it("says a document name beside a URL inside the same bracket tag is still checked", () => {
    expect(readme).toMatch(
      /a `?<name>\.pdf`? elsewhere inside the same brackets[\s\S]{0,200}is still extracted and checked/i,
    );
  });

  it("states the quoted-name shape rule including its leading character", () => {
    expect(readme).toMatch(/begin(?:s|ning) with a letter or digit/i);
  });

  it("discloses that a citation glued to a URL by a sub-delimiter is dropped in every status", () => {
    expect(readme).toMatch(/dropped in every status/i);
  });

  it("documents the https requirement on PAGEINDEX_BASE_URL and its loopback exception", () => {
    expect(readme).toMatch(/PAGEINDEX_BASE_URL[\s\S]{0,400}https/i);
    expect(readme).toMatch(/localhost[\s\S]{0,40}127\.0\.0\.1[\s\S]{0,40}\[::1\]/);
  });

  it("states that .pdf is the only recognized extension", () => {
    expect(readme).toMatch(/only `?\.pdf`? documents are recognized/i);
  });

  it("discloses that a bare name in a script without word spaces is not extracted", () => {
    expect(readme).toMatch(/does not separate words with spaces[\s\S]{0,300}quote/i);
  });

  it("tells the operator never to delete an `unchecked` citation", () => {
    expect(readme).toMatch(/unchecked`? citation[\s\S]{0,120}(leave it in place|do not delete)/i);
  });
});
