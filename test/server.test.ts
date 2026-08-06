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
import { NO_NEAR_MATCH_SUGGESTION, MAX_DISTINCT_DOCUMENTS } from "../src/resolver.js";
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

  // Review finding (P2): the handler ignored the request's AbortSignal, so a host that
  // cancelled or timed out left the server sweeping the remaining documents - sequential
  // lookups, each bounded only by the SDK's 60-second default - spending API quota on a result
  // nobody would read. This is the wiring test: it drives a REAL cancellation through the MCP
  // transport rather than calling verifyCitations directly, because the defect was entirely in
  // the handler signature and a resolver-level test cannot see it.
  it("stops looking documents up once the caller cancels the request", async () => {
    const lookedUp: string[] = [];
    const controller = new AbortController();
    let firstLookupSeen: (() => void) | undefined;
    const firstLookup = new Promise<void>((resolve) => {
      firstLookupSeen = resolve;
    });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const client: DocLookup = {
      async getDocument(docName) {
        lookedUp.push(docName);
        if (lookedUp.length === 1) {
          firstLookupSeen?.();
          // Hold the first lookup open until the test has cancelled and the cancellation has
          // actually been delivered to the server. Nothing here races on a timer.
          await held;
        }
        return { found: true, doc: { name: docName, pageCount: 10 } };
      },
      async getNodeIds() {
        return new Set<string>();
      },
    };

    const mcpClient = await connectedClient(client);
    const call = mcpClient.callTool(
      { name: "verify_citations", arguments: { text: "See a.pdf and b.pdf and c.pdf." } },
      undefined,
      { signal: controller.signal },
    );

    await firstLookup;
    controller.abort();
    await expect(call).rejects.toThrow();
    release?.();
    // The sweep must not have gone on to b.pdf or c.pdf after the cancellation landed.
    await new Promise((resolve) => setImmediate(resolve));
    expect(lookedUp).toEqual(["a.pdf"]);
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
  // else in the description - each one was mutation-tested individually to confirm it
  // actually discriminates: deleting only the clause it guards fails that assertion while
  // the rest stay green.
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
    // `title` as what distinguishes them) so a rewording cannot restore the old "confirmed
    // absent from the corpus" reading while keeping the other pieces.
    //
    // `title` is now the discriminator, not `suggestion`: resolver.ts sets `title` to the
    // document's real name on EVERY verdict where the backend positively confirmed the
    // document, so the delete-versus-fix decision is machine-readable instead of only
    // readable in English prose. The iff wording is pinned inside the same regex as the
    // "not always missing" correction, because the correction without the field it hangs on
    // is what the old description already said.
    expect(description).toMatch(
      /unresolved`?\s*-\s*an ARRAY of tokens whose miss was POSITIVELY established against the corpus, which does NOT always mean the document is missing: a document that IS present, cited with a page outside its real page count or a node absent from its outline, is `?unresolved`? too, but carries the document's real `?title`?: `?title`? is non-null IF AND ONLY IF the backend confirmed the cited document exists, whatever the status, so `?title`? - not `?suggestion`? - is what distinguishes the two/i,
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
    // `suggestion` is described as something to act on, not just a field name. All THREE of
    // its forms are pinned in one conjunction: a near-miss name, an explanation of a miss
    // that WAS checked (the page count, or the resolver's static no-near-match reminder),
    // and an explanation of what could not be checked. The two-form wording this replaced
    // was not false, but it let a consuming model infer that an `unresolved` with no
    // near-miss name carries an empty `suggestion` - which resolver.ts never produces. The
    // closing "never means an empty `suggestion`" clause is inside the same regex, so it
    // cannot be dropped while the three-form list survives.
    //
    // The guarantee now covers `unchecked` too, and that half is load-bearing rather than
    // decorative: resolver.ts has exactly three `unchecked` return points (bare node id,
    // failed document lookup, unreadable outline) and each one pushes a non-null
    // explanation, so a consuming agent that is told to keep an `unchecked` citation can
    // always be told WHY it was kept. Pinned inside the same conjunction so the `unchecked`
    // half cannot be dropped while the `unresolved` half survives.
    expect(description).toMatch(
      /suggestion`? may carry a near-miss document name, an explanation of a miss that WAS checked \(the real page count, or a fixed case-sensitivity reminder when a document is absent and the backend offered no near name\), or an explanation of what could not be checked; every `?unresolved`? and every `?unchecked`? carries one, so an absent near-miss name never means an empty `?suggestion`?/i,
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
    // The imperative is pinned TOGETHER with its exception: an `unresolved` whose `title`
    // is non-null names a document that exists and only the page or node missed, and must
    // be corrected, not deleted. Splitting these into two assertions would let the exception
    // be dropped while the imperative stayed green - the deletion harm this whole
    // distinction exists to prevent.
    //
    // The exception is stated against `title` rather than `suggestion` because no
    // suggestion resolver.ts emits ever literally says "the document exists" - the page-count
    // and node-absent strings only IMPLY it, so a model applying the old rule literally fell
    // through to the delete branch on a citation whose source is real. `title` non-null is
    // the same fact as a machine-readable field.
    expect(description).toMatch(
      /For each `unresolved` citation, remove the claim or replace it with a verified citation - unless its `title` is non-null, which means the document exists and only the page or node missed, in which case fix that instead \(`suggestion` says which half missed\)\./,
    );
    // --- the rename caution. README.md has carried it since before this description did,
    // and the asymmetry was the dangerous half: a human reads the README once at
    // integration time, while THIS string is read by the model on every call, and the
    // model is what edits the draft. "replace it with a verified citation" (immediately
    // above) plus a `suggestion` reading `Did you mean "report.pdf"?` is close to an
    // instruction to perform the exact substitution that converts a caught fabrication
    // into an uncaught one - the citation resolves, and nothing checked whether the real
    // document supports the claim. Pinned as ONE conjunction (diagnostic-not-rename-target,
    // the reason, and the consequence) so a rewording cannot keep the label while dropping
    // what makes it actionable.
    expect(description).toMatch(
      /A near-miss name in `suggestion` is a diagnostic, NOT a rename target: only existence is checked, so swapping the suggested name in and leaving the claim as written turns a caught fabrication into an uncaught one/,
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
    // The separator clause makes TWO claims and only ever guarded one of them. "No other
    // document name in between" is a statement about the characters BETWEEN the name and the
    // page keyword, and it was true of the separator all along - but the evidence that the
    // page belongs to somebody else sits on the FAR side of the page number ("methods.pdf,
    // page 12 of results.pdf"), where that clause never looked. The second half is pinned
    // with the first so the guarantee cannot be read as broader than the code delivers.
    expect(description).toMatch(
      /on the SAME LINE, with no other document name in between and none named by the page phrase itself in the form described below/i,
    );
    // --- audit fix (Critical): a page phrase naming its own document binds to NEITHER.
    // Pinned as one conjunction - the trigger, the worked example, the "binds to NEITHER"
    // verdict, and the "rather than the document on its left" correction - because the rule
    // without the correction reads as a mere omission, when what it actually prevents is a
    // page bound to the wrong document (a false `unresolved` carrying a non-null `title`,
    // i.e. the fix-do-not-delete signal, on a citation that was correct). The recovery
    // instruction is pinned too: a dropped page is silent, and a silence is only recoverable
    // if the reader is told how.
    //
    // Re-review (Critical 2): the trigger is no longer "`of` or `in` plus a name" - that
    // enumeration was the defect, since every other spelling of the same sentence bound the
    // page to the WRONG document. The assertion moved with the claim rather than being
    // deleted: it now pins the structural trigger (ANY following name, at most three
    // connecting words, decorations skipped).
    expect(description).toMatch(
      /A page phrase that names its OWN document - ANY `<name>\.pdf` following the page, separated from it by at most three connecting words and by any amount of whitespace, quotes, brackets, emphasis marks or dashes, as in `methods\.pdf, page 12 of results\.pdf`, `page 12 of the results\.pdf` or `page 12 of 'results\.pdf'` - binds to NEITHER document: the page is dropped and both are checked without it, rather than the page being bound to the document on its left\. Write the page against the name it belongs to \(`results\.pdf p\.12`\) to have it verified\./,
    );
    // The residue is pinned WITH the rule, in the same block, because a guarantee published
    // without its exceptions is what made the previous version of this clause dangerous: the
    // model reads it as an affirmative guard and stops checking. Each named exception is a
    // shape where the page still binds LEFT, so each is a place a correct citation can come
    // back `unresolved` with a non-null `title`.
    expect(description).toMatch(
      /The page still binds LEFT - correct for a list, WRONG for an owner - when the two are separated by `and` or `or`, by any punctuation \(`,` `;` `:` `\.`\), by a line break BEFORE the connecting words, or by a fourth connecting word/,
    );
    expect(description).toMatch(
      /`methods\.pdf p\.3 and results\.pdf p\.7` keeps both pages, while `methods\.pdf, page 12 of the second half of results\.pdf` still binds page 12 to `methods\.pdf`\./,
    );
    expect(description).toMatch(
      /So does an owner the grammar cannot see as a document at all \(`__results\.pdf__`, `sub\/results\.pdf`\)\./,
    );

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
    // The name-boundary rule, and the correction it forced. grammar.ts now decides where a
    // bare name may start and end from a CLOSED allowlist of boundary characters, so any
    // character outside it - `/ : % + @ # = & \` and every format control - continues the
    // identifier and the name is never emitted. That inverts the old scheme-relative /
    // bare-host disclosure: those forms no longer produce a false `unresolved`, they produce
    // nothing at all, which moves them from the over-reach list to the under-reach list.
    // Pinned as ONE conjunction - the character set, the "NOT extracted in ANY status"
    // consequence, the three worked examples, and the URL forms it subsumes - because the
    // rule without its examples reads as reassurance, and the URL half without the rule
    // would leave a reader thinking only URLs are affected.
    expect(description).toMatch(
      /A name must also stand as its own token: a name touching `\/`, `:`, `%`, `\+`, `@`, `#`, `=`, `&`, `\\` or a format control character is NOT extracted in ANY status - `sub\/chapter\.pdf`, `ns:chapter\.pdf` and `report\+final\.pdf` are all silent, and so are the scheme-relative \(`\/\/host\/doc\.pdf`\) and bare-host \(`host\/doc\.pdf`\) URL forms, which are therefore dropped rather than falsely `unresolved`/i,
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
    // The no-space colon form, a direct consequence of the name-boundary rule above: `:` is
    // a continuation character, so the name in `[node:report.pdf]` is glued into the id and
    // both syntaxes report one `unchecked` node instead of checking the document. Safe
    // direction (an `unchecked` citation is never deleted) but silently different from the
    // spaced form, so it has to be disclosed with the fix - the space.
    expect(description).toMatch(
      /Written with NO space after the colon, `\[node:report\.pdf\]` and `node_id:report\.pdf` are `unchecked` rather than checked, because the colon glues the name into the id - write a space to have the document checked/,
    );
    // --- audit fix (Important): the value's end is now a three-way limit, and the third one
    // (a nested `[`) silences the whole tag. Pinned with its worked example and with the
    // "a `<name>.pdf` written inside it still is" half, because the rule without that half
    // reads as "anything inside such a tag is invisible", which would send a reader hunting
    // for a missing document check that does in fact happen.
    expect(description).toMatch(
      /A tag's value ends at the closing `\]`, a newline or a nested `\[`, so a tag whose value contains a `\[` \(`\[node: abc\[1\]\]`\) is not reported at all - though a `<name>\.pdf` written inside it still is/,
    );
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
    // (grammar.ts NAME_CHARS), and the leading-character rule is pinned as one conjunction
    // with the word/character limits so it cannot rot out again. A single `_`, `-` or `.`
    // bound to a letter or digit is admitted (a legal file name); the same character followed
    // by a space is not, because that is prose decoration.
    expect(description).toMatch(
      /file-name-shaped \(at most 4 words, 80 characters, starting with a letter or digit or a single leading `_`, `-` or `\.` bound to one, and otherwise only letters\/digits\/spaces\/dots\/underscores\/hyphens - letters and digits of ANY script count\)/i,
    );
    // The two caps fail DIFFERENTLY, and the asymmetry is the whole reason the fragment
    // leak is narrowed rather than closed. Pinned as one clause with its justification: a
    // rewording that keeps "over 4 words" and "over 80 characters" but swaps which one emits
    // nothing would invert the safety property while leaving both halves present.
    expect(description).toMatch(
      /Over 4 words is the case that can still leave a fragment, because 5 words of letters and spaces is indistinguishable from an ordinary quoted sentence; over 80 characters within 4 words emits NOTHING at all instead \(`total: 0`\)/,
    );
    // Containment for the Unicode widening: a BARE name in a script with no word spaces is
    // not extracted at all, and quoting is the supported route for it.
    //
    // The second half is the accepted cost of the name-boundary rule: a no-space-script
    // character is neither a name character nor a boundary, so a Latin-script name written
    // straight after such text is silent too. That was ruled on deliberately - the
    // alternative admits those characters into names, which brings back swallowing a whole
    // clause as a document name, and a false `unresolved` is worse than a silence. Pinned in
    // the SAME regex as the bare-name half so the disclosed cost cannot rot out while the
    // capability claim survives.
    expect(description).toMatch(
      /A BARE name written in a script that does not separate words with spaces \(Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan\) is not extracted at all \(`total: 0`\), and neither is a Latin-script name written directly against such text with no space between them; quote it to have it checked/,
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
//
// The prose documentation is now TWO files, not one: README.md carries what a stranger needs
// to get running and to decide whether to trust the tool, and docs/citation-grammar.md carries
// the exhaustive per-shape reference that used to sit inside the README. A guard has to follow
// its content, so the assertions below read whichever file the claim now lives in - and where a
// claim is stated in BOTH (the README summarizes it, the reference states it in full), BOTH are
// pinned, because a summary that quietly stops matching its own reference is the same rot in a
// new place. Deleting an assertion to make a move compile would reopen the exact hole this
// block exists to close.
describe("the prose documentation states the load-bearing claims the tool description states", () => {
  // Whitespace is collapsed before matching: both files are hard-wrapped, so any claim long
  // enough to matter spans a line break, and pinning the break positions would make this a
  // formatting test - re-wrapping a paragraph would fail it while every claim stayed true.
  const collapsed = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\s+/g, " ");
  const readme = collapsed("../README.md");
  const grammarDoc = collapsed("../docs/citation-grammar.md");

  // --- claims the README must carry ITSELF: a reader who never follows the link to the
  // grammar reference must not be misled about any of them ---

  it("carries both halves of the `total: 0` guard", () => {
    expect(readme).toMatch(
      /`?total: 0`? means no citation of a recognized shape was found[^.]*- it is not a clean bill of health, and not proof the text has no citations/i,
    );
  });

  it("quotes the no-near-match suggestion exactly as the resolver emits it", () => {
    // The worked example prints this suggestion verbatim, and it is the ONE piece of the
    // README that is a literal copy of a string in the code rather than a paraphrase of a
    // claim - so it rots the instant the constant is reworded, silently and with the suite
    // green. The constant is IMPORTED, never re-typed here: a test carrying its own copy of
    // the string would pin the copy to itself and bind the README to nothing. Whitespace is
    // collapsed on both sides for the same reason as everywhere else in this block - the
    // README may re-wrap the quotation without any claim changing.
    expect(readme).toContain(NO_NEAR_MATCH_SUGGESTION.replace(/\s+/g, " "));
  });

  it("says an `unresolved` verdict does not always mean a missing document, and names `title` as the discriminator", () => {
    // Pinned as ONE ordered conjunction, not two independent assertions: the correction
    // ("not always missing") without the field that carries the difference is what the
    // README already said when `title` was null on both, and the field name without the
    // correction reads as a description of a JSON key rather than a decision rule. `title`
    // is the machine-readable delete-versus-fix signal (resolver.ts CitationDetail), so
    // this is the one README claim a consuming agent's operator most needs to be true.
    expect(readme).toMatch(
      /`unresolved` does not always mean the document is missing[\s\S]{0,700}`title` is what distinguishes the two/i,
    );
  });

  it("states the `title` invariant: non-null if and only if the document was confirmed", () => {
    // The invariant itself, stated where a reader looks up what the field means rather than
    // only inside the `unresolved` discussion above. Both directions are pinned in one
    // expression: "if and only if ... confirmed" and what `null` therefore means. Half of it
    // alone would let the README claim `title` is "the resolved document's name" again,
    // which was false the moment an `unresolved` and an `unchecked` began carrying one.
    expect(readme).toMatch(
      /`title`[\s\S]{0,200}if and only if[\s\S]{0,200}confirmed that document[\s\S]{0,300}`title: null` means the document was never confirmed to exist/i,
    );
  });

  it("warns that a near-name suggestion is not a rename target", () => {
    // Counterpart to the tool-description assertion of the same claim above, so the two
    // surfaces cannot drift apart on it again - this one existed here first, and its
    // absence from the description was the gap: the model, not the human, is what acts.
    expect(readme).toMatch(
      /a diagnostic, not a licence to rename a citation and keep the same claim[\s\S]{0,600}converts a caught fabrication into an uncaught one/i,
    );
  });

  it("tells the operator where a failed lookup is diagnosed", () => {
    // resolver.ts logLookupFailure writes the only signal an operator ever gets for the most
    // common production failure, and it goes to stderr rather than into the tool result. A
    // README that does not say so leaves an outage, a wrong-account key and a backend change
    // indistinguishable. Pinned together with the stdout prohibition, which is what makes the
    // channel choice non-negotiable (test/stdout-safety.test.ts).
    expect(readme).toMatch(/one line to this server's stderr/i);
    expect(readme).toMatch(/stdout carries the MCP protocol stream/i);
  });

  it("states that a document must be named by its exact stored file name", () => {
    // The single rule that decides whether ANY citation can resolve (pageindex-client.ts looks
    // documents up by literal `doc_name`, and grammar.ts never case-normalizes a name). All
    // three parts - exact stored name, extension included, case-sensitive - are pinned as one
    // conjunction: "exact file name" alone would still pass while the case rule rotted out.
    expect(readme).toMatch(
      /exact stored file name[\s\S]{0,40}including the extension, matched case-sensitively/i,
    );
  });

  it("documents the https requirement on PAGEINDEX_BASE_URL and its loopback exception", () => {
    expect(readme).toMatch(/PAGEINDEX_BASE_URL[\s\S]{0,400}https/i);
    expect(readme).toMatch(/localhost[\s\S]{0,40}127\.0\.0\.1[\s\S]{0,40}\[::1\]/);
  });

  it("tells the operator never to delete an `unchecked` citation", () => {
    expect(readme).toMatch(/unchecked`? citation[\s\S]{0,120}(leave it in place|do not delete)/i);
  });

  // --- claims stated in BOTH files: the README summarizes the shape rules, the reference
  // states them in full. Each is pinned in both, so neither copy can rot out alone. ---

  it("states in both files that .pdf is the only recognized extension", () => {
    expect(readme).toMatch(/only `?\.pdf`? documents are recognized/i);
    expect(grammarDoc).toMatch(/only `?\.pdf`? documents are recognized/i);
  });

  it("states the quoted-name shape rule including its leading character, in both files", () => {
    // A leading `_`, `-` or `.` is admitted only when bound to a letter or digit. Both halves
    // are pinned: dropping the binding condition would describe a grammar that reads a quoted
    // list bullet as a document name, which is the opposite trade from the one implemented.
    expect(readme).toMatch(
      /start(?:s|ing) with a letter or digit[\s\S]{0,60}single `?_`?, `?-`? or `?\.`? bound directly to one/i,
    );
    expect(grammarDoc).toMatch(
      /start(?:s|ing) with a letter or digit[\s\S]{0,60}single `?_`?, `?-`? or `?\.`? bound directly to one/i,
    );
  });

  // The asymmetry between the two caps is a safety property, not a detail: over the word limit
  // can still leave a fragment checked as a different document, over the character limit emits
  // nothing. A reader who has only half of that will trust a `resolved` verdict they should
  // have checked, so both files must carry both halves.
  it("states in both files that the character limit drops rather than leaving a fragment", () => {
    expect(readme).toMatch(/80-character limit[\s\S]{0,40}drops? it rather than leaving a fragment/i);
    expect(grammarDoc).toMatch(
      /character limit does NOT fail that way[\s\S]{0,400}emits \*\*nothing at all\*\*/i,
    );
  });

  // The per-call lookup cap is a limit an operator has to know about, because it changes what
  // a complete-looking result means: a large draft can come back with citations `unchecked`
  // for a reason that has nothing to do with the backend. The NUMBER is read from the
  // implementation rather than written here, so raising the cap without updating the README
  // fails instead of quietly publishing a stale figure - the same rot this whole block exists
  // to catch, and the reason MAX_DISTINCT_DOCUMENTS is exported at all.
  it("discloses the per-call distinct-document cap, with the real number", () => {
    expect(readme).toMatch(
      new RegExp(`at most ${MAX_DISTINCT_DOCUMENTS} distinct documents are looked up per call`, "i"),
    );
    // And says which way it fails. A cap that produced `unresolved` would make a consuming
    // agent delete work over a budget decision, so the safe direction is the load-bearing half.
    expect(readme).toMatch(/comes? back `unchecked`[\s\S]{0,80}never\s+`unresolved`/i);
  });

  it("discloses in both files that a bare name in a script without word spaces is not extracted", () => {
    expect(readme).toMatch(/does not separate words with spaces[\s\S]{0,300}quote/i);
    expect(grammarDoc).toMatch(/does not separate words with spaces[\s\S]{0,300}quote/i);
  });

  it("discloses in both files that a bracket-tag value ends at a nested `[`", () => {
    // Substance only: each file must say where the value ends and what a nested `[` costs.
    // The consequence is a silence, and a silence is only recoverable if it is written down.
    expect(readme).toMatch(
      /value ends at the closing `\]`, a newline or a nested `\[`[\s\S]{0,200}not recognized as a tag at all/i,
    );
    expect(grammarDoc).toMatch(
      /a tag whose value contains a `\[` is not recognized as a tag at all[\s\S]{0,200}reports nothing/i,
    );
  });

  it("discloses in both files that a page naming its own document is dropped, not bound", () => {
    // The counterpart of the tool-description assertion above, for the two human-facing
    // surfaces. Substance only: each file must state the trigger (`of`/`in` plus a document
    // name) and the outcome (neither document carries the page), in whatever words it uses.
    expect(readme).toMatch(
      /page phrase that names\s+its own document[\s\S]{0,300}binds to neither/i,
    );
    expect(grammarDoc).toMatch(
      /A page phrase that names its own document binds to neither[\s\S]{0,600}the page is \*\*dropped\*\*/i,
    );
  });

  it("discloses in both files where a page still binds to the document on its left", () => {
    // Re-review (Critical 2). The rule above is not absolute, and the previous round shipped
    // it as though it were - the tool description offered the model an affirmative guard that
    // held for one spelling of the sentence. These are the shapes where the page still binds
    // LEFT and can therefore report a correct citation `unresolved` with a non-null `title`.
    // Substance only, in whatever words each file uses: the trigger (`and`/`or`, punctuation,
    // a line break before the connecting words, a fourth word) and the consequence.
    expect(readme).toMatch(
      /page can still bind to the document on its left[\s\S]{0,600}fourth (connecting )?word/i,
    );
    expect(readme).toMatch(/`and`\/`or`|`and`, `or`|`and` or `or`/);
    expect(grammarDoc).toMatch(
      /still bind[\s\S]{0,200}page 12 to `methods\.pdf`[\s\S]{0,400}fourth connecting word/i,
    );
    // And the mirror: a page dropped where binding would have been correct, which is the
    // price this rule pays for erring towards silence.
    expect(readme).toMatch(/drops the page in genuinely ambiguous cases/i);
    expect(grammarDoc).toMatch(/drops a page that would have bound correctly/i);
  });

  it("states in the grammar reference that the owner rule is structural, not a preposition list", () => {
    // The enumeration is what failed twice. If a future change reverts to a closed list of
    // prepositions, this document must not keep claiming otherwise - and the claim is the
    // only place a reader can learn that `from`, `within` and `of the` are covered.
    expect(grammarDoc).toMatch(/structural rather than a list of prepositions/i);
    expect(grammarDoc).toMatch(/at most three\*{0,2} connecting words/i);
  });

  it("discloses in both files that a citation glued to a URL by a sub-delimiter is dropped in every status", () => {
    expect(readme).toMatch(/dropped in every status/i);
    expect(grammarDoc).toMatch(/dropped in every status/i);
  });

  it("discloses in both files that a name touching a glue character is not extracted at all", () => {
    // grammar.ts NAME_BOUNDARY is a closed allowlist, so every character outside it - these
    // nine and every format control - continues an identifier and the name is never emitted.
    // The counterpart assertion against the live tool description is in the block above; this
    // is the human-facing half. The worked examples are pinned with the character set,
    // because a reader who cannot recognize the shape cannot avoid writing it.
    expect(readme).toMatch(/`\/`, `:`, `%`, `\+`, `@`, `#`, `=`, `&`, `\\`[\s\S]{0,400}sub\/chapter\.pdf/i);
    expect(grammarDoc).toMatch(/`\/`, `:`, `%`, `\+`, `@`, `#`, `=`, `&`, `\\`[\s\S]{0,400}sub\/chapter\.pdf/i);
  });

  it("discloses in both files that a scheme-relative or bare-host URL is now silent, not `unresolved`", () => {
    // This one INVERTED: both files used to warn that these two forms were read as ordinary
    // document names and could come back `unresolved`. They now yield nothing. A stale
    // over-reach warning is not harmless here - it tells a reader to go hunting for false
    // `unresolved` verdicts that the code can no longer produce, and hides the real failure
    // mode, which is silence.
    expect(readme).toMatch(
      /scheme-relative[\s\S]{0,120}bare-host[\s\S]{0,200}(silent|dropped|not extracted|not recognized|yields? nothing)/i,
    );
    expect(grammarDoc).toMatch(
      /scheme-relative[\s\S]{0,120}bare host[\s\S]{0,200}(silent|dropped|not extracted|not recognized|yields? nothing)/i,
    );
  });

  it("tells the reader what leaves the machine", () => {
    // pageindex-client.ts sends `{doc_name}` and `{doc_name, part}` and nothing else - the
    // draft text never crosses the network. That is the first question anyone asks before
    // piping an agent's full output through a tool, and it is a fact in this project's
    // favour, so its absence is a real omission rather than a stylistic one.
    expect(readme).toMatch(/draft text never leaves this process/i);
    expect(readme).toMatch(/doc_name/);
  });

  // --- claims that now live ONLY in the grammar reference. The exhaustive per-shape detail
  // moved out of the README, so its guard moved with it rather than being dropped. ---

  it("says a document name beside a URL inside the same bracket tag is still checked", () => {
    expect(grammarDoc).toMatch(
      /a `?<name>\.pdf`? elsewhere inside the same brackets[\s\S]{0,200}is still extracted and checked/i,
    );
  });

  // --- the grammar reference is reachable directly from a search engine, so it must restate
  // the two verdicts and the naming rule itself rather than assume the README's context ---

  it("the grammar reference restates the exact-stored-name rule for a reader arriving directly", () => {
    expect(grammarDoc).toMatch(
      /exact stored file name[\s\S]{0,40}including the extension, matched case-sensitively/i,
    );
  });

  it("the grammar reference restates the `unresolved` vs `unchecked` distinction", () => {
    expect(grammarDoc).toMatch(
      /`unresolved` means the citation was checked against the corpus and positively not found[\s\S]{0,30}`unchecked` means the check could not run/i,
    );
  });

  it("the grammar reference restates the `total: 0` guard", () => {
    expect(grammarDoc).toMatch(
      /`?total: 0`? means no citation of a recognized shape was found[\s\S]{0,40}not a clean bill of health, and not proof the text has no citations/i,
    );
  });

  it("the README links the grammar reference where its summary ends", () => {
    // The summary is only honest if the exhaustive version is one click away; a summary that
    // silently loses its link becomes a partial account presented as a whole one.
    expect(readme).toMatch(/docs\/citation-grammar\.md/);
  });
});
