import { expect } from "chai";
import { describe, it } from "mocha";
import { auditEvents, auditEventsDetailed, closestWindow, diagnoseDroppedQuote, locateQuote, parseRawEvents, passageAround, summariseDrops } from "../src/utils/case-reconstruction-events-parse";
import { buildCaseReconstructionEventsPrompt, buildDateAnchorPack } from "../src/utils/case-reconstruction-events-prompt";
import type { BundleFact } from "../src/utils/bundle-facts";

const block = (json: unknown) => `noise\n[EVENTS]\n${JSON.stringify(json)}\n[/EVENTS]\ntrailing`;

describe("parseRawEvents", () => {
  it("parses events, dropping ones with no proposition and normalising dates", () => {
    const got = parseRawEvents(
      block([
        { date: "2026-08-06", proposition: "HR asked Doe to report", assertedBy: "HR email", docId: "d1", page: 2, quote: "Please report" },
        { date: "6 August", proposition: "Bad date format", docId: "d1", quote: "x" },
        { date: "2026-02-30", proposition: "Impossible date", docId: "d1", quote: "x" },
        { date: "2026-08-07", docId: "d1", quote: "no proposition" },
      ]),
    )!;
    expect(got.map((e) => e.proposition)).to.deep.equal(["HR asked Doe to report", "Bad date format", "Impossible date"]);
    expect(got.map((e) => e.date)).to.deep.equal(["2026-08-06", null, null]);
    expect(got[0].assertedBy).to.equal("HR email");
    expect(got[1].assertedBy).to.equal(null);
  });

  it("accepts a fenced or unclosed block, and returns undefined when there is nothing usable", () => {
    const fenced = '[EVENTS]\n```json\n[{"date":"2026-08-06","proposition":"p","docId":"d","quote":"q"}]\n```\n[/EVENTS]';
    expect(parseRawEvents(fenced)).to.have.length(1);
    expect(parseRawEvents("no tags at all")).to.equal(undefined);
    expect(parseRawEvents(block([]))).to.equal(undefined);
    expect(parseRawEvents(block("not an array"))).to.equal(undefined);
  });
});

describe("auditEvents", () => {
  const docs = new Set(["d1", "d2"]);
  const corpus = new Map([
    ["d1", "Notice of Termination.\nYour employment is terminated   effective 11 August 2026."],
    ["d2", "Payroll: Doe worked 4 Aug to 8 Aug."],
  ]);
  const raw = (docId: string, quote: string | undefined, date: string | null = "2026-08-11") => ({
    date,
    proposition: "p",
    assertedBy: null,
    rawSourceRef: { docId, page: 1, quote },
  });

  it("keeps a source whose quote is in the named document, ignoring whitespace and case", () => {
    const [e] = auditEvents([raw("d1", "employment is terminated effective 11 august 2026")], docs, corpus);
    expect(e.sourceRef).to.deep.equal({ docId: "d1", page: 1, quote: "employment is terminated effective 11 august 2026" });
  });

  it("drops the source, not the event, when the quote is missing, invented, or in another document", () => {
    for (const r of [raw("d1", undefined), raw("d1", "an invented sentence"), raw("d1", "Doe worked 4 Aug"), raw("nope", "Notice of Termination")]) {
      const [e] = auditEvents([r], docs, corpus);
      expect(e.sourceRef).to.equal(null);
      expect(e.proposition).to.equal("p");
    }
  });

  it("drops a restated event — same date, same wording once case and punctuation go", () => {
    const r = (proposition: string, date: string | null = "2026-08-04") => ({ date, proposition, assertedBy: null, rawSourceRef: { docId: "d1", page: 1, quote: "x" } });
    const got = auditEvents(
      [r("Doe clocked in at 07:56."), r("doe clocked in at 07:56"), r("Doe clocked in at 07:56.", "2026-08-05"), r("Doe clocked in at 08:10.")],
      docs,
      corpus,
    );
    expect(got.map((e) => [e.date, e.proposition])).to.deep.equal([
      ["2026-08-04", "Doe clocked in at 07:56."],
      ["2026-08-04", "Doe clocked in at 08:10."],
      ["2026-08-05", "Doe clocked in at 07:56."],
    ]);
  });

  it("orders by date with undated events last, then numbers them", () => {
    const got = auditEvents([raw("d1", "x", null), raw("d1", "x", "2026-08-11"), raw("d1", "x", "2026-07-28")], docs, corpus);
    expect(got.map((e) => [e.index, e.date])).to.deep.equal([[0, "2026-07-28"], [1, "2026-08-11"], [2, null]]);
  });
});

describe("passageAround", () => {
  it("centres the window on the quote and falls back to the head when it is absent", () => {
    const text = `${"a ".repeat(2000)}KEY QUOTE here${" b".repeat(2000)}`;
    const p = passageAround(text, "key quote", 400);
    expect(p).to.have.length.at.most(400);
    expect(p.toLowerCase()).to.contain("key quote");
    expect(locateQuote(text, "missing")).to.equal(-1);
    expect(passageAround("short text", "missing", 400)).to.equal("short text");
  });
});

const fact = (documentId: string, value: string, sentence: string, extra: Partial<BundleFact> = {}): BundleFact => ({
  chunkId: `${documentId}-c`,
  documentId,
  pageNumber: 1,
  exhibit: null,
  locator: "p.1",
  kind: "date",
  value,
  display: value,
  sentence,
  yearInferred: false,
  ...extra,
});

describe("buildDateAnchorPack", () => {
  const names = new Map([["d1", "Termination letter"], ["d2", "Payroll"]]);

  it("lists date facts chronologically with document and locator, one per date per document", () => {
    const pack = buildDateAnchorPack(
      [
        fact("d1", "2026-08-11", "Terminated effective 11 August."),
        fact("d1", "2026-08-11", "A second mention in the same document."),
        fact("d2", "2026-08-04", "Payroll from 4 Aug.", { yearInferred: true }),
        fact("d1", "GBP5.00" as string, "not a date", { kind: "amount" }),
      ],
      names,
    ).split("\n");
    expect(pack).to.have.length(2);
    expect(pack[0]).to.contain("2026-08-04 (year inferred) [docId d2; p.1, Payroll]");
    expect(pack[1]).to.contain("2026-08-11 [docId d1; p.1, Termination letter]: Terminated effective 11 August.");
  });

  it("when over the cap, keeps dates several documents share first", () => {
    const facts = [fact("d1", "2026-01-01", "only one doc"), fact("d1", "2026-06-06", "shared"), fact("d2", "2026-06-06", "shared too")];
    const pack = buildDateAnchorPack(facts, names, 2);
    expect(pack).to.contain("2026-06-06");
    expect(pack).to.not.contain("2026-01-01");
  });
});

describe("buildCaseReconstructionEventsPrompt", () => {
  it("carries the anchors, documents, excerpts and the proposition-not-allegation rule", () => {
    const p = buildCaseReconstructionEventsPrompt({ docs: [{ id: "d1", name: "Letter" }], anchors: "- 2026-08-11 ANCHOR", excerpts: "EXCERPT TEXT" });
    for (const s of ["- 2026-08-11 ANCHOR", "`d1` — Letter", "EXCERPT TEXT", "Do not use \"alleged\"", "Give each fact once", "Merge routine day-by-day records", "[EVENTS]", "[/EVENTS]"]) expect(p).to.contain(s);
  });

  it("requires a quote for every event and does not offer omitting it as an alternative", () => {
    // The first real dropped quote (NO_QUOTE, the 12 Aug service event) followed the old wording
    // "Omit quote rather than paraphrase it", which invites skipping the quote whenever copying is hard.
    const p = buildCaseReconstructionEventsPrompt({ docs: [], anchors: "", excerpts: "" });
    expect(p).to.contain("The quote is required");
    expect(p).to.contain("leave that event out");
    expect(p).to.not.match(/omit\s+"?quote"?\s+rather/i);
  });
});

describe("why a quote was dropped", () => {
  const ready = new Set(["docket", "letter"]);
  const corpus = new Map([
    ["docket", "On 18 August 2026 the complainant filed an Amended Complaint adding a cause of action for illegal dismissal."],
    ["letter", "Your employment is terminated effective 11 August 2026 on the ground of abandonment."],
  ]);

  it("calls it COSMETIC when only punctuation or spacing differs", () => {
    // Curly quotes, a hyphen for a space, doubled punctuation: locateQuote misses, ignoring all of it finds.
    const d = diagnoseDroppedQuote("docket", "the complainant filed an Amended-Complaint, adding a cause of action", ready, corpus);
    expect(d.kind).to.equal("COSMETIC");
  });

  it("calls it WRONG_DOCUMENT when the quote is verbatim in another ready document", () => {
    const d = diagnoseDroppedQuote("docket", "employment is terminated effective 11 August 2026", ready, corpus);
    expect(d.kind).to.equal("WRONG_DOCUMENT");
    expect(d.foundIn).to.deep.equal(["letter"]);
  });

  it("calls it PARAPHRASE when the text is nowhere, and shows the closest stretch and the words that differ", () => {
    const d = diagnoseDroppedQuote("docket", "The claimant lodged an amended complaint adding illegal dismissal as a ground", ready, corpus);
    expect(d.kind).to.equal("PARAPHRASE");
    expect(d.closest?.docId).to.equal("docket");
    expect(d.closest?.snippet).to.contain("amended complaint");
    expect(d.closest?.matched).to.be.greaterThan(3);
    expect(d.closest?.missing).to.include.members(["claimant", "lodged"]);
    expect(d.closest?.extra.length).to.be.greaterThan(0);
  });

  it("separates a missing quote from an unknown document", () => {
    expect(diagnoseDroppedQuote("docket", undefined, ready, corpus).kind).to.equal("NO_QUOTE");
    expect(diagnoseDroppedQuote("nope", "anything", ready, corpus).kind).to.equal("UNKNOWN_DOCUMENT");
    expect(diagnoseDroppedQuote(undefined, "anything", ready, corpus).kind).to.equal("UNKNOWN_DOCUMENT");
  });

  it("finds the closest window without scanning quadratically, and copes with empty input", () => {
    const big = `${"filler words here ".repeat(20000)} the payroll register shows eight hours paid ${"more filler ".repeat(20000)}`;
    const t0 = Date.now();
    const w = closestWindow(big, "payroll register shows 8.0 hours paid");
    expect(Date.now() - t0).to.be.lessThan(1000);
    expect(w?.snippet).to.contain("payroll register shows");
    expect(closestWindow("", "x")).to.equal(null);
    expect(closestWindow("text", "")).to.equal(null);
  });

  it("auditEventsDetailed reports each dropped source with the event it belonged to, and drops nothing that held", () => {
    const raw = (docId: string, quote: string | undefined, proposition: string) => ({ date: "2026-08-18", proposition, assertedBy: null, rawSourceRef: { docId, page: 1, quote } });
    const { events, dropped } = auditEventsDetailed(
      [
        raw("docket", "filed an Amended Complaint adding a cause of action", "Held"),
        raw("docket", "lodged an amended complaint adding illegal dismissal", "Reworded"),
        raw("docket", "employment is terminated effective 11 August 2026", "Wrong doc"),
      ],
      ready,
      corpus,
    );
    expect(events.map((e) => [e.proposition, !!e.sourceRef])).to.deep.equal([["Held", true], ["Reworded", false], ["Wrong doc", false]]);
    expect(dropped.map((d) => [d.proposition, d.kind])).to.deep.equal([["Reworded", "PARAPHRASE"], ["Wrong doc", "WRONG_DOCUMENT"]]);
    expect(dropped[0].date).to.equal("2026-08-18");
    expect(summariseDrops(dropped)).to.deep.equal({ PARAPHRASE: 1, WRONG_DOCUMENT: 1 });
    expect(auditEventsDetailed([raw("docket", "filed an Amended Complaint adding a cause of action", "Held")], ready, corpus).dropped).to.deep.equal([]);
  });
});
