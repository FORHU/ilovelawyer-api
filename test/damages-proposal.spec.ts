import { expect } from "chai";
import { describe, it } from "mocha";
import { evidenceNameMatches, figuresDiffer, mergeProposedBasis, parseDamageProposal } from "../src/utils/damages-proposal";

describe("figuresDiffer", () => {
  const rate = (monthlyRate: number, extra: Record<string, unknown> = {}) => ({
    basis: { kind: "RATE_X_PERIOD", monthlyRate, ...extra },
    amount: null,
  });

  it("compares the rate, and months only when the document states them", () => {
    expect(figuresDiffer(rate(27000, { months: 18 }), rate(28500))).to.equal(true);
    expect(figuresDiffer(rate(27000, { months: 18 }), rate(27000))).to.equal(false);
    expect(figuresDiffer(rate(27000, { months: 18 }), rate(27000, { months: 20 }))).to.equal(true);
  });

  it("compares fixed amounts, percentages and a change of kind", () => {
    expect(figuresDiffer({ basis: null, amount: 200000 }, { basis: { kind: "FIXED" }, amount: 200000 })).to.equal(false);
    expect(figuresDiffer({ basis: null, amount: 200000 }, { basis: { kind: "FIXED" }, amount: 250000 })).to.equal(true);
    const pct = (percent: number, categories: string[]) => ({ basis: { kind: "PERCENT_OF", percent, categories }, amount: null });
    expect(figuresDiffer(pct(10, ["ACTUAL", "MORAL"]), pct(10, ["MORAL", "ACTUAL"]))).to.equal(false);
    expect(figuresDiffer(pct(10, ["ACTUAL"]), pct(10, ["ACTUAL", "MORAL"]))).to.equal(true);
    expect(figuresDiffer({ basis: null, amount: 1 }, rate(1))).to.equal(true);
  });
});

describe("mergeProposedBasis", () => {
  it("keeps the lawyer's period and accrual when only the rate changes", () => {
    const current = { kind: "RATE_X_PERIOD", monthlyRate: 27000, fromDate: "2025-03-28", untilDate: "asOf", highUntilDate: "2027-03-28" };
    expect(mergeProposedBasis(current, { kind: "RATE_X_PERIOD", monthlyRate: 28500, months: 12 })).to.deep.equal({
      ...current,
      monthlyRate: 28500,
    });
  });

  it("takes stated months when the head had no dates, and the found basis for a change of kind", () => {
    expect(
      mergeProposedBasis({ kind: "RATE_X_PERIOD", monthlyRate: 27000, months: 18 }, { kind: "RATE_X_PERIOD", monthlyRate: 28500, months: 20 }),
    ).to.deep.equal({ kind: "RATE_X_PERIOD", monthlyRate: 28500, months: 20 });
    expect(mergeProposedBasis(null, { kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL"] })).to.deep.equal({
      kind: "PERCENT_OF",
      percent: 10,
      categories: ["ACTUAL"],
    });
  });
});

describe("evidenceNameMatches", () => {
  it("matches the pending evidence against the document's name or folder", () => {
    expect(evidenceNameMatches("payroll certification", { name: "Payroll_Certification_2025.pdf" })).to.equal(true);
    expect(evidenceNameMatches("payroll certification", { name: "cert.pdf", category: "Payroll Certificates" })).to.equal(true);
  });

  it("can't tell from an unrelated name, or from an empty requirement", () => {
    expect(evidenceNameMatches("payroll certification", { name: "Payslip Aug 2025.pdf" })).to.equal(null);
    expect(evidenceNameMatches("a of", { name: "anything" })).to.equal(null);
  });
});

describe("parseDamageProposal", () => {
  it("reads a stored proposal and rejects anything malformed", () => {
    const p = parseDamageProposal({
      basis: { kind: "RATE_X_PERIOD", monthlyRate: 28500 },
      amount: null,
      sourceDocumentId: "d",
      documentName: "Payroll cert.pdf",
      sourceQuote: "Monthly rate: P28,500.00",
      satisfiesPending: true,
      proposedAt: "2026-09-28T00:00:00.000Z",
    });
    expect(p).to.include({ satisfiesPending: true, sourceDocumentId: "d" });
    expect(parseDamageProposal(null)).to.equal(null);
    expect(parseDamageProposal({ basis: { kind: "FIXED" } })).to.equal(null);
  });
});
