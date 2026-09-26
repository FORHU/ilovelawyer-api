import { expect } from "chai";
import { describe, it } from "mocha";
import { assessEvent, assessEvents, markUnchecked, AssessDeps, CHECK_FAILED_NOTE, NO_SOURCE_NOTE } from "../src/utils/reconstruction-event-assess";
import { ALLEGATION_PHRASED_NOTE } from "../src/utils/reconstruction-event-status";
import type { ReconstructionEvent } from "../src/utils/case-reconstruction-events-parse";
import type { AssertionCheck } from "../src/utils/assertion-check";
import type { BundleFact } from "../src/utils/bundle-facts";

const event = (over: Partial<ReconstructionEvent> = {}): ReconstructionEvent => ({
  index: 0,
  date: "2026-08-05",
  proposition: "Doe was at her station on 5 August",
  assertedBy: null,
  sourceRef: { docId: "poe", page: 1, quote: "seeing Ms. Doe at her station" },
  ...over,
});
const ctx = {
  facts: [] as BundleFact[],
  fullTextByDocId: new Map([
    ["poe", "Statement of R. Poe: I recall seeing Ms. Doe at her station on the afternoon of 5 August."],
    ["log", "Attendance log 5 August 2026. Doe at her station 3, clocked in 07:58."],
  ]),
};
const check = (over: Partial<AssertionCheck> = {}): AssertionCheck => ({
  verdict: "SUPPORTED",
  confidence: 0.95,
  evidenceKind: "SHOWN_BY_DOCUMENT",
  kindConfidence: 0.9,
  notes: "n",
  ...over,
});
const fact = (documentId: string): BundleFact => ({
  chunkId: `${documentId}-c`,
  documentId,
  pageNumber: 1,
  exhibit: null,
  locator: "p.1",
  kind: "date",
  value: "2026-08-05",
  display: "5 August 2026",
  sentence: "Attendance log 5 August 2026. Doe at her station 3, clocked in 07:58.",
  yearInferred: false,
});

function deps(over: Partial<AssessDeps> & { calls?: string[] } = {}): AssessDeps {
  const calls = over.calls ?? [];
  return {
    classifyPhrasing: over.classifyPhrasing ?? (async () => ({ phrasing: "FACT", confidence: 1, rawPhrasing: "FACT" })),
    checkAssertion:
      over.checkAssertion ??
      (async (_a, _p, citation) => {
        calls.push(citation ?? "");
        return check();
      }),
  };
}

describe("assessEvent", () => {
  it("skips every Jev call for an event with no verified source", async () => {
    let called = false;
    const d = deps({ classifyPhrasing: async () => ((called = true), { phrasing: "FACT", confidence: 1, rawPhrasing: "FACT" }) });
    const out = await assessEvent(event({ sourceRef: null }), ctx, d);
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.equal(NO_SOURCE_NOTE);
    expect(called).to.equal(false);
  });

  it("flags an allegation without running the source check", async () => {
    const calls: string[] = [];
    const out = await assessEvent(event(), ctx, deps({ calls, classifyPhrasing: async () => ({ phrasing: "ALLEGATION", confidence: 0.99, rawPhrasing: "ALLEGATION" }) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.equal(ALLEGATION_PHRASED_NOTE);
    expect(calls).to.have.length(0);
  });

  it("runs the ordinary check when the phrasing call fails", async () => {
    const out = await assessEvent(event(), ctx, deps({ classifyPhrasing: async () => Promise.reject(new Error("jev down")) }));
    expect(out.status).to.equal("VERIFIED");
  });

  it("derives Verified, Disputed and Unverified from the check", async () => {
    const run = (c: AssertionCheck) => assessEvent(event(), ctx, deps({ checkAssertion: async () => c }));
    expect((await run(check())).status).to.equal("VERIFIED");
    expect((await run(check({ verdict: "CONTRADICTED" }))).status).to.equal("DISPUTED");
    expect((await run(check({ evidenceKind: "ASSERTED_BY_PARTY" }))).status).to.equal("UNVERIFIED");
    expect((await run(check({ verdict: "UNSUPPORTED" }))).status).to.equal("UNVERIFIED");
  });

  it("never turns a failed check into Disputed", async () => {
    const out = await assessEvent(event(), ctx, deps({ checkAssertion: async () => Promise.reject(new Error("jev down")) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.equal(CHECK_FAILED_NOTE);
  });

  it("leaves a lone witness account Unverified", async () => {
    const out = await assessEvent(event(), ctx, deps({ checkAssertion: async () => check({ evidenceKind: "STATED_BY_WITNESS" }) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.corroboratedBy).to.equal(undefined);
  });

  it("verifies a witness account an independent document shows, and records which", async () => {
    const withLog = { ...ctx, facts: [fact("log")] };
    const out = await assessEvent(
      event(),
      withLog,
      deps({ checkAssertion: async (_a, _p, citation) => (citation === "log" ? check() : check({ evidenceKind: "STATED_BY_WITNESS" })) }),
    );
    expect(out.status).to.equal("VERIFIED");
    expect(out.corroboratedBy).to.deep.equal(["log"]);
  });

  it("does not count a second source that only shows a record's silence", async () => {
    const silent = { ...ctx, facts: [{ ...fact("log"), sentence: "Attendance log 5 August 2026: no entry recorded for Doe at her station." }] };
    const out = await assessEvent(
      event(),
      { ...silent, fullTextByDocId: new Map([...ctx.fullTextByDocId, ["log", "Attendance log 5 August 2026: no entry recorded for Doe at her station."]]) },
      deps({ checkAssertion: async (_a, _p, citation) => (citation === "log" ? check() : check({ evidenceKind: "STATED_BY_WITNESS" })) }),
    );
    expect(out.status).to.equal("UNVERIFIED");
  });

  it("only looks for corroboration when a witness account is supported", async () => {
    const calls: string[] = [];
    await assessEvent(event(), { ...ctx, facts: [fact("log")] }, deps({ calls })); // SHOWN_BY_DOCUMENT
    expect(calls).to.deep.equal(["poe"]);
  });
});

describe("assessEvent — what other documents say", () => {
  const awol = event({
    date: "2026-08-04",
    proposition: "Doe was absent without leave from 4 August",
    assertedBy: "Acme HR, notice of termination",
    sourceRef: { docId: "letter", page: 1, quote: "absent without leave since 4 August 2026" },
  });
  const otherFact = (documentId: string, sentence: string): BundleFact => ({ ...fact(documentId), value: "2026-08-04", display: "4 August 2026", sentence });
  const cx = (facts: BundleFact[]) => ({
    facts,
    fullTextByDocId: new Map([["letter", "You have been absent without leave since 4 August 2026."], ...facts.map((f) => [f.documentId, f.sentence] as [string, string])]),
    docNames: new Map([["payroll", "Payroll register"]]),
  });
  const byCitation = (answers: Record<string, Partial<AssertionCheck>>) => async (_a: string, _p: string, citation?: string) => check(answers[citation ?? ""] ?? {});

  it("overturns a Verified-looking party claim when another document says the opposite", async () => {
    // The first end-to-end run: the employer's letter 'shows' AWOL, so it came out Verified at 100%.
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid")]);
    const out = await assessEvent(awol, ctx, deps({ checkAssertion: byCitation({ letter: { evidenceKind: "SHOWN_BY_DOCUMENT" }, payroll: { verdict: "CONTRADICTED", confidence: 0.99 } }) }));
    expect(out.status).to.equal("DISPUTED");
    expect(out.contradictedBy).to.deep.equal(["payroll"]);
    expect(out.statusNote).to.equal("Its own source states this (confidence 95%), but Payroll register contradicts it (confidence 99%).");
  });

  it("names how many other documents contradict it", async () => {
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid"), otherFact("attendance", "4 August 2026 - clocked in 07:56")]);
    const out = await assessEvent(awol, ctx, deps({ checkAssertion: byCitation({ letter: { evidenceKind: "SHOWN_BY_DOCUMENT" }, payroll: { verdict: "CONTRADICTED", confidence: 0.99 }, attendance: { verdict: "CONTRADICTED", confidence: 0.9 } }) }));
    expect(out.contradictedBy).to.have.length(2);
    expect(out.statusNote).to.contain("and 1 other document contradict it");
  });

  it("reads a document that shares no words with the event — words rank, they never filter", async () => {
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid")]);
    const read: string[] = [];
    await assessEvent(awol, ctx, deps({ checkAssertion: async (_a, _p, c) => (read.push(c ?? ""), check()) }));
    expect(read).to.include("payroll");
  });

  it("lets an independent document settle a party's own claim", async () => {
    const claim = event({ date: "2026-08-05", proposition: "Doe reported for work on 5 August", assertedBy: "Doe, affidavit", sourceRef: { docId: "affidavit", page: 1, quote: "reported for work" } });
    const ctx = { facts: [{ ...fact("attendance"), sentence: "5 August 2026 - clocked in 07:58" }], fullTextByDocId: new Map([["affidavit", "I reported for work every day."], ["attendance", "5 August 2026 - clocked in 07:58"]]) };
    const out = await assessEvent(claim, ctx, deps({ checkAssertion: byCitation({ affidavit: { evidenceKind: "ASSERTED_BY_PARTY" }, attendance: { evidenceKind: "SHOWN_BY_DOCUMENT" } }) }));
    expect(out.status).to.equal("VERIFIED");
    expect(out.corroboratedBy).to.deep.equal(["attendance"]);
  });

  it("lets a contradiction win over a corroboration", async () => {
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid"), otherFact("attendance", "4 August 2026 - clocked in 07:56")]);
    const out = await assessEvent(awol, ctx, deps({ checkAssertion: byCitation({ letter: { evidenceKind: "SHOWN_BY_DOCUMENT" }, payroll: { verdict: "CONTRADICTED" }, attendance: { evidenceKind: "SHOWN_BY_DOCUMENT" } }) }));
    expect(out.status).to.equal("DISPUTED");
  });

  it("does not sweep an event nobody is answerable for, or one without a date", async () => {
    const calls: string[] = [];
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid")]);
    await assessEvent({ ...awol, assertedBy: null }, ctx, deps({ calls })); // a document that simply is the event
    await assessEvent({ ...awol, date: null }, ctx, deps({ calls }));
    expect(calls).to.deep.equal(["letter", "letter"]);
  });

  it("ranks documents by their whole passage, so a contradiction behind a fragment of a sentence is still read", async () => {
    // The e2e run: the affidavit's picked sentence was cut at "Mr." and shared no words with the event,
    // so it tied with unrelated records and, last of many, fell outside those read.
    const claim = event({ date: "2026-08-06", proposition: "Doe did not appear at the HR office at 2:00 PM on 6 August", assertedBy: "Acme, position paper", sourceRef: { docId: "paper", page: 1, quote: "did not appear" } });
    const rec = (documentId: string): BundleFact => ({ ...fact(documentId), value: "2026-08-06", display: "6 August 2026", sentence: `6 August 2026 - record ${documentId}` });
    const affidavit: BundleFact = { ...fact("affidavit"), value: "2026-08-06", display: "6 August 2026", sentence: "On 6 August 2026 I received an email from Mr." };
    const facts = [rec("a"), rec("b"), rec("c"), rec("d"), rec("e"), rec("f"), rec("g"), affidavit]; // the affidavit last, as document order had it
    const fullTextByDocId = new Map<string, string>([
      ["paper", "Doe did not appear at the HR office at 2:00 PM on 6 August."],
      ["affidavit", "On 6 August 2026 I received an email from Mr. Roe. I went to the HR office at 2:00 PM on 6 August 2026 and waited."],
      ...["a", "b", "c", "d", "e", "f", "g"].map((d) => [d, `6 August 2026 - record ${d}`] as [string, string]),
    ]);
    const read: string[] = [];
    const out = await assessEvent(claim, { facts, fullTextByDocId }, deps({
      checkAssertion: async (_a, _p, c) => {
        read.push(c ?? "");
        return c === "affidavit" ? check({ verdict: "CONTRADICTED", confidence: 1 }) : check({ evidenceKind: c === "paper" ? "ASSERTED_BY_PARTY" : "SHOWN_BY_DOCUMENT", verdict: c === "paper" ? "SUPPORTED" : "UNSUPPORTED" });
      },
    }));
    expect(read).to.include("affidavit");
    expect(out.status).to.equal("DISPUTED");
    expect(out.contradictedBy).to.deep.equal(["affidavit"]);
  });

  it("reads at most six other documents, and one that fails is neither for nor against", async () => {
    const facts = ["a", "b", "c", "d", "e", "f", "g", "h"].map((d) => otherFact(d, `4 August 2026 - record ${d}`));
    const read: string[] = [];
    const out = await assessEvent(
      awol,
      cx(facts),
      deps({
        checkAssertion: async (_a, _p, c) => {
          read.push(c ?? "");
          if (c === "a") throw new Error("jev down");
          return check({ evidenceKind: c === "letter" ? "ASSERTED_BY_PARTY" : "SHOWN_BY_DOCUMENT", verdict: c === "letter" ? "SUPPORTED" : "UNSUPPORTED" });
        },
      }),
    );
    expect(read.filter((c) => c !== "letter")).to.have.length(6);
    expect(out.status).to.equal("UNVERIFIED"); // the party claim stands alone: nothing corroborated, nothing contradicted
    expect(out.contradictedBy).to.equal(undefined);
  });

  it("leaves a party's uncontested claim Unverified, and says nobody confirms or contradicts it", async () => {
    const start = event({ date: "2022-03-03", proposition: "Doe has been employed since 3 March 2022", assertedBy: "Jane Doe, affidavit", sourceRef: { docId: "affidavit", page: 1, quote: "since 3 March 2022" } });
    const out = await assessEvent(start, { facts: [], fullTextByDocId: new Map([["affidavit", "employed since 3 March 2022"]]) }, deps({ checkAssertion: async () => check({ evidenceKind: "ASSERTED_BY_PARTY" }) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.equal("Asserted by Jane Doe, affidavit only; nothing else in the record confirms or contradicts it.");
  });

  it("says a lone witness account is unconfirmed, rather than that the passage 'bears it out'", async () => {
    // A note reading like a Verified one, under an Unverified badge, told the lawyer nothing.
    const out = await assessEvent(event({ assertedBy: "R. Poe, statement" }), ctx, deps({ checkAssertion: async () => check({ evidenceKind: "STATED_BY_WITNESS" }) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.equal("Stated by R. Poe, statement only; no other document in the record confirms it.");
  });

  it("never turns a failed cross-document check into Disputed", async () => {
    // Every sweep call fails: the claim is unconfirmed, not contested.
    const ctx = cx([otherFact("payroll", "4 August 2026 - 8.0 hours - paid"), otherFact("attendance", "4 August 2026 - clocked in 07:56")]);
    const out = await assessEvent(
      awol,
      ctx,
      deps({
        checkAssertion: async (_a, _p, c) => {
          if (c !== "letter") throw new Error("jev down");
          return check({ evidenceKind: "ASSERTED_BY_PARTY" });
        },
      }),
    );
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.contradictedBy).to.equal(undefined);
  });

  it("calls a supported-but-unsure check Unverified and says why", async () => {
    const out = await assessEvent(event(), ctx, deps({ checkAssertion: async () => check({ confidence: 0.24 }) }));
    expect(out.status).to.equal("UNVERIFIED");
    expect(out.statusNote).to.contain("not confidently enough");
    expect(out.statusNote).to.contain("24%");
  });
});

describe("assessEvents / markUnchecked", () => {
  it("assesses every event and keeps their order", async () => {
    const events = Array.from({ length: 12 }, (_, i) => event({ index: i }));
    const out = await assessEvents(events, ctx, deps());
    expect(out.map((e) => e.index)).to.deep.equal(events.map((e) => e.index));
    expect(out.every((e) => e.status === "VERIFIED")).to.equal(true);
  });

  it("marks everything Unverified, with the right note, when the check is off", () => {
    const out = markUnchecked([event(), event({ sourceRef: null })]);
    expect(out.map((e) => e.status)).to.deep.equal(["UNVERIFIED", "UNVERIFIED"]);
    expect(out[1].statusNote).to.equal(NO_SOURCE_NOTE);
    expect(out[0].statusNote).to.contain("switched off");
  });
});
