import { expect } from "chai";
import { describe, it } from "mocha";
import { damageHeadKey, extractDamageHeads, numbersIn } from "../src/utils/damages-extract-parse";

const PAYSLIP =
  "PAYSLIP — August 2025\nEmployee: Juan Dela Cruz\nBasic monthly salary: P27,000.00\nNet pay: P24,310.00";
const COMPLAINT =
  "WHEREFORE, complainant prays that respondent be ordered to pay P200,000.00 as moral damages, " +
  "P100,000.00 as exemplary damages, and attorney's fees equivalent to ten percent (10%) of the total monetary award.";
const DOCS = new Map([
  ["doc-pay", PAYSLIP],
  ["doc-cmp", COMPLAINT],
]);

function block(rows: unknown[]): string {
  return `[DAMAGES]\n${JSON.stringify(rows)}\n[/DAMAGES]`;
}

describe("extractDamageHeads", () => {
  it("keeps heads whose quote is in the document and holds every figure", () => {
    const heads = extractDamageHeads(
      block([
        {
          category: "ACTUAL",
          label: "Backwages",
          basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 },
          legalBasis: null,
          pendingEvidence: "payroll certification",
          documentId: "doc-pay",
          quote: "Basic monthly salary: P27,000.00",
        },
        {
          category: "MORAL",
          label: "Moral damages",
          basis: { kind: "FIXED", amount: 200000 },
          documentId: "doc-cmp",
          quote: "pay P200,000.00 as moral damages",
        },
        {
          category: "ATTORNEYS_FEES",
          label: "Attorney's fees",
          basis: { kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL", "MORAL", "EXEMPLARY", "NOPE"] },
          documentId: "doc-cmp",
          quote: "attorney's fees equivalent to ten percent (10%) of the total monetary award",
        },
      ]),
      DOCS,
    )!;

    expect(heads.map((h) => h.category)).to.deep.equal(["ACTUAL", "MORAL", "ATTORNEYS_FEES"]);
    expect(heads[0]!.basis).to.deep.equal({ kind: "RATE_X_PERIOD", monthlyRate: 27000 });
    expect(heads[0]!.pendingEvidence).to.equal("payroll certification");
    expect(heads[1]!).to.include({ amount: 200000 });
    expect(heads[1]!.basis).to.deep.equal({ kind: "FIXED" });
    expect(heads[2]!.basis).to.deep.equal({ kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL", "MORAL", "EXEMPLARY"] });
  });

  it("drops a head whose figure isn't in its quote (a fabricated rate)", () => {
    const heads = extractDamageHeads(
      block([
        {
          category: "ACTUAL",
          basis: { kind: "RATE_X_PERIOD", monthlyRate: 30000 },
          documentId: "doc-pay",
          quote: "Basic monthly salary: P27,000.00",
        },
      ]),
      DOCS,
    );
    expect(heads).to.deep.equal([]);
  });

  it("drops a quote that isn't in the cited document, or cites an unknown document", () => {
    const heads = extractDamageHeads(
      block([
        { category: "MORAL", basis: { kind: "FIXED", amount: 200000 }, documentId: "doc-pay", quote: "pay P200,000.00 as moral damages" },
        { category: "MORAL", basis: { kind: "FIXED", amount: 200000 }, documentId: "doc-x", quote: "pay P200,000.00 as moral damages" },
      ]),
      DOCS,
    );
    expect(heads).to.deep.equal([]);
  });

  it("keeps the rate but drops a period the quote doesn't state", () => {
    const heads = extractDamageHeads(
      block([
        {
          category: "ACTUAL",
          basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000, months: 18 },
          documentId: "doc-pay",
          quote: "Basic monthly salary: P27,000.00",
        },
      ]),
      DOCS,
    )!;
    expect(heads[0]!.basis).to.deep.equal({ kind: "RATE_X_PERIOD", monthlyRate: 27000 });
  });

  it("matches a quote the model re-flowed across a line break", () => {
    const heads = extractDamageHeads(
      block([
        { category: "ACTUAL", basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000 }, documentId: "doc-pay", quote: "Juan Dela Cruz Basic monthly salary: P27,000.00" },
      ]),
      DOCS,
    )!;
    expect(heads).to.have.length(1);
  });

  it("dedupes by category, but keeps separately-labelled OTHER heads", () => {
    const doc = new Map([["d", "13th month pay: P27,000.00. Service incentive leave pay: P4,500.00."]]);
    const heads = extractDamageHeads(
      block([
        { category: "OTHER", label: "13th month pay", basis: { kind: "FIXED", amount: 27000 }, documentId: "d", quote: "13th month pay: P27,000.00" },
        { category: "OTHER", label: "Service incentive leave", basis: { kind: "FIXED", amount: 4500 }, documentId: "d", quote: "Service incentive leave pay: P4,500.00" },
        { category: "OTHER", label: "13th Month Pay", basis: { kind: "FIXED", amount: 27000 }, documentId: "d", quote: "13th month pay: P27,000.00" },
      ]),
      doc,
    )!;
    expect(heads.map((h) => h.label)).to.deep.equal(["13th month pay", "Service incentive leave"]);
  });

  it("returns undefined without a block, and [] for an empty one", () => {
    expect(extractDamageHeads("I could not find anything.", DOCS)).to.equal(undefined);
    expect(extractDamageHeads("[DAMAGES]\n[]\n[/DAMAGES]", DOCS)).to.deep.equal([]);
  });

  it("drops rows with a bad category, basis kind or out-of-range percent", () => {
    const heads = extractDamageHeads(
      block([
        { category: "PUNITIVE", basis: { kind: "FIXED", amount: 200000 }, documentId: "doc-cmp", quote: "pay P200,000.00 as moral damages" },
        { category: "MORAL", basis: { kind: "TOTAL", amount: 200000 }, documentId: "doc-cmp", quote: "pay P200,000.00 as moral damages" },
        { category: "ATTORNEYS_FEES", basis: { kind: "PERCENT_OF", percent: 200000, categories: ["ACTUAL"] }, documentId: "doc-cmp", quote: "pay P200,000.00 as moral damages" },
      ]),
      DOCS,
    );
    expect(heads).to.deep.equal([]);
  });
});

describe("damages-extract-parse helpers", () => {
  it("numbersIn reads figures with separators and decimals", () => {
    expect(numbersIn("P200,000.00 as moral damages and ten percent (10%)")).to.deep.equal([200000, 10]);
  });

  it("damageHeadKey keys OTHER by label and the rest by category", () => {
    expect(damageHeadKey("MORAL", "Moral damages")).to.equal("MORAL");
    expect(damageHeadKey("OTHER", " 13th  Month pay")).to.equal(damageHeadKey("OTHER", "13th month pay"));
    expect(damageHeadKey("OTHER", "SIL")).to.not.equal(damageHeadKey("OTHER", "13th month pay"));
  });
});
