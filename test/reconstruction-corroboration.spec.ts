import { expect } from "chai";
import { describe, it } from "mocha";
import { findCorroborationCandidates, isAbsenceOfRecord, isCorroboratingCheck } from "../src/utils/reconstruction-corroboration";
import type { BundleFact } from "../src/utils/bundle-facts";

const fact = (documentId: string, value: string, sentence: string, kind: BundleFact["kind"] = "date"): BundleFact => ({
  chunkId: `${documentId}-c`,
  documentId,
  pageNumber: 1,
  exhibit: null,
  locator: `${documentId} p.1`,
  kind,
  value,
  display: value,
  sentence,
  yearInferred: false,
});

const query = { eventDate: "2026-08-05", proposition: "Doe was at her station on 5 August", sourceDocumentId: "poe" };

describe("findCorroborationCandidates", () => {
  it("finds another document that states the same date about the same thing", () => {
    const log = fact("attendance", "2026-08-05", "Attendance log: Doe clocked in at her station on 5 August 2026.");
    const got = findCorroborationCandidates(query, [log]);
    expect(got).to.have.length(1);
    expect(got[0].fact.documentId).to.equal("attendance");
  });

  it("never lets the event's own source corroborate it", () => {
    const own = fact("poe", "2026-08-05", "Doe was at her station on 5 August 2026.");
    expect(findCorroborationCandidates(query, [own])).to.have.length(0);
  });

  it("ignores a matching date in a sentence about something else", () => {
    const lunch = fact("menu", "2026-08-05", "Lunch was served at the canteen on 5 August 2026.");
    expect(findCorroborationCandidates(query, [lunch])).to.have.length(0);
  });

  it("ignores a different date, and non-date facts", () => {
    const other = fact("attendance", "2026-08-06", "Doe clocked in at her station on 6 August 2026.");
    const amount = fact("attendance", "GBP5.00", "Doe at her station paid 5 August", "amount");
    expect(findCorroborationCandidates(query, [other, amount])).to.have.length(0);
  });

  it("keeps only the strongest candidate per document, best first", () => {
    const q = { ...query, proposition: "Doe was at her station on the afternoon of 5 August" };
    const weak = fact("attendance", "2026-08-05", "Doe station check on 5 August 2026.");
    const strong = fact("attendance", "2026-08-05", "Doe was at her station on the afternoon of 5 August 2026 per the log.");
    const email = fact("email", "2026-08-05", "Doe at her station, confirmed on 5 August.");
    const got = findCorroborationCandidates(q, [weak, strong, email]);
    expect(got.map((c) => c.fact.documentId).sort()).to.deep.equal(["attendance", "email"]);
    expect(got.find((c) => c.fact.documentId === "attendance")!.fact.sentence).to.equal(strong.sentence);
  });
});

describe("isCorroboratingCheck", () => {
  it("accepts a supported document or established fact", () => {
    expect(isCorroboratingCheck({ verdict: "SUPPORTED", evidenceKind: "SHOWN_BY_DOCUMENT", confidence: 0.95 })).to.equal(true);
    expect(isCorroboratingCheck({ verdict: "SUPPORTED", evidenceKind: "ESTABLISHED", confidence: 0.95 })).to.equal(true);
  });
  it("rejects a supported check the model was unsure of", () => {
    expect(isCorroboratingCheck({ verdict: "SUPPORTED", evidenceKind: "SHOWN_BY_DOCUMENT", confidence: 0.4 })).to.equal(false);
  });
  it("rejects allegations, another witness, and anything unsupported", () => {
    expect(isCorroboratingCheck({ verdict: "SUPPORTED", evidenceKind: "ASSERTED_BY_PARTY", confidence: 0.95 })).to.equal(false);
    expect(isCorroboratingCheck({ verdict: "SUPPORTED", evidenceKind: "STATED_BY_WITNESS", confidence: 0.95 })).to.equal(false);
    expect(isCorroboratingCheck({ verdict: "UNSUPPORTED", evidenceKind: "SHOWN_BY_DOCUMENT", confidence: 0.95 })).to.equal(false);
    expect(isCorroboratingCheck({ verdict: "CONTRADICTED", evidenceKind: "SHOWN_BY_DOCUMENT", confidence: 0.95 })).to.equal(false);
  });
});

describe("absence of record", () => {
  it("recognises a record's silence", () => {
    for (const p of [
      "HR office: 2:00 PM — no entry recorded for M. Doe.",
      "There is no record of a meeting on 6 August.",
      "Attendance at the meeting was not recorded.",
      "Nothing on file for that date.",
    ]) expect(isAbsenceOfRecord(p), p).to.equal(true);
  });

  it("does not flag a passage that states the event", () => {
    for (const p of [
      "Acme attendance log, 5 August 2026. Doe, Jane — clocked in 07:58, station 3.",
      "Sent: 6 August 2026 09:12. Please report to the HR office at 2:00 PM today.",
    ]) expect(isAbsenceOfRecord(p), p).to.equal(false);
  });

  it("stops a supported-looking check from corroborating when the passage only shows silence", () => {
    const check = { verdict: "SUPPORTED", evidenceKind: "SHOWN_BY_DOCUMENT", confidence: 0.95 } as const;
    expect(isCorroboratingCheck(check, "no entry recorded for M. Doe")).to.equal(false);
    expect(isCorroboratingCheck(check, "Doe clocked in at station 3")).to.equal(true);
    expect(isCorroboratingCheck(check)).to.equal(true);
  });
});
