import { expect } from "chai";
import { describe, it } from "mocha";
import { damageHeadKey, extractDamageHeads, numbersIn, parseDamageEstimates } from "../src/utils/damages-extract-parse";

const DOC = "8f14e45f-ceea-467f-a8f0-2b1c3d4e5f60";
const LETTER = "c9f0f895-fb98-4b91-9c2a-0d1e2f3a4b5c";
const docText =
  "WHEREFORE, complainant prays for backwages of P486,000.00, moral damages of P200,000.00, and reinstatement to her former position without loss of seniority.";
const letterText =
  "You will receive 12 weeks' notice. Your gross pay is £450 per week. Claims (1) automatically unfair dismissal, s.103A ERA 1996; (2) disability discrimination.";
const texts = new Map([
  [DOC, docText],
  [LETTER, letterText],
]);
const docs = [
  { id: DOC, name: "Complaint.pdf" },
  { id: LETTER, name: "Dismissal letter.pdf" },
];
const reply = (rows: unknown[]) => `[DAMAGES]\n${JSON.stringify(rows)}\n[/DAMAGES]`;

describe("extractDamageHeads", () => {
  it("reads damages with the amount their quote states, and remedies with none, citing a document by handle", () => {
    const heads = extractDamageHeads(
      reply([
        { kind: "DAMAGE", title: "Backwages", description: "Unpaid wages", amount: 486000, quotes: [{ documentId: "D1", quote: "backwages of P486,000.00" }] },
        { kind: "REMEDY", title: "Reinstatement", description: null, amount: null, quotes: [{ documentId: "D1", quote: "reinstatement to her former position" }] },
      ]),
      texts,
      docs,
    );
    expect(heads?.map((h) => [h.title, h.amount, h.amountBasis, h.documentId, h.quote, h.figure])).to.deep.equal([
      ["Backwages", 486000, "STATED", DOC, "backwages of P486,000.00", "486000"],
      ["Reinstatement", null, null, DOC, "reinstatement to her former position", null],
    ]);
  });

  it("still reads the older single documentId and quote, by full id", () => {
    const heads = extractDamageHeads(
      reply([{ kind: "DAMAGE", title: "Moral damages", amount: 200000, documentId: DOC, quote: "moral damages of P200,000.00" }]),
      texts,
      docs,
    );
    expect(heads?.map((h) => [h.title, h.amount, h.documentId])).to.deep.equal([["Moral damages", 200000, DOC]]);
  });

  it("works out rate × count from two quoted lines and keeps the working", () => {
    const heads = extractDamageHeads(
      reply([
        {
          kind: "DAMAGE",
          title: "Notice pay",
          description: "Pay for the notice period.",
          amount: null,
          calculation: { rate: 450, count: 12, unit: "weeks" },
          quotes: [
            { documentId: "D2", quote: "You will receive 12 weeks' notice." },
            { documentId: "D2", quote: "Your gross pay is £450 per week." },
          ],
        },
      ]),
      texts,
      docs,
    );
    expect(heads).to.have.length(1);
    expect(heads![0]).to.include({
      amount: 5400,
      amountBasis: "CALCULATED",
      amountNote: "12 weeks × 450 a week",
      documentId: LETTER,
      figure: "12 weeks × 450 a week",
      description: "Pay for the notice period.",
    });
    expect(heads![0].calculation).to.deep.equal({ rate: 450, count: 12, unit: "week" });
    expect(heads![0].quote).to.equal("You will receive 12 weeks' notice. … Your gross pay is £450 per week.");
  });

  it("keeps a head a claim brings with the AI's estimate, marked as one, and nothing for Jev to check", () => {
    const claim = [{ documentId: "D2", quote: "(2) disability discrimination" }];
    const heads = extractDamageHeads(
      reply([
        {
          kind: "DAMAGE",
          title: "Injury to feelings",
          amount: null,
          estimate: { amount: 15000, basis: "Lower-middle of the usual range for a one-off act of discrimination." },
          quotes: claim,
        },
        { kind: "DAMAGE", title: "Compensatory award", amount: null, estimate: { amount: 9000 }, quotes: claim },
        { kind: "REMEDY", title: "Declaration", estimate: { amount: 1, basis: "n/a" }, quotes: claim },
      ]),
      texts,
      docs,
    );
    expect(heads?.map((h) => [h.title, h.amount, h.amountBasis, h.amountNote, h.figure])).to.deep.equal([
      ["Injury to feelings", 15000, "ESTIMATE", "Lower-middle of the usual range for a one-off act of discrimination.", null],
      // An estimate with no basis isn't kept as one; the head stays, with no amount.
      ["Compensatory award", null, null, null, null],
      // Remedies never carry an estimate.
      ["Declaration", null, null, null, null],
    ]);
  });

  it("prefers a stated amount over an estimate", () => {
    const heads = extractDamageHeads(
      reply([
        {
          kind: "DAMAGE",
          title: "Moral damages",
          amount: 200000,
          estimate: { amount: 50000, basis: "Usual award." },
          quotes: [{ documentId: "D1", quote: "moral damages of P200,000.00" }],
        },
      ]),
      texts,
      docs,
    );
    expect(heads?.map((h) => [h.amount, h.amountBasis])).to.deep.equal([[200000, "STATED"]]);
  });

  it("drops a calculation whose rate or count is in none of its quotes", () => {
    const heads = extractDamageHeads(
      reply([
        {
          kind: "DAMAGE",
          title: "Notice pay",
          calculation: { rate: 500, count: 12, unit: "week" },
          quotes: [{ documentId: "D2", quote: "You will receive 12 weeks' notice." }],
        },
        {
          kind: "DAMAGE",
          title: "Holiday pay",
          calculation: { rate: 450, count: 3, unit: "fortnight" },
          quotes: [{ documentId: "D2", quote: "Your gross pay is £450 per week." }],
        },
      ]),
      texts,
      docs,
    );
    expect(heads).to.deep.equal([]);
  });

  it("drops an entry whose amount isn't in its quote, whose quote isn't in the document, or that cites another document", () => {
    const heads = extractDamageHeads(
      reply([
        { kind: "DAMAGE", title: "Moral damages", amount: 250000, quotes: [{ documentId: "D1", quote: "moral damages of P200,000.00" }] },
        { kind: "DAMAGE", title: "Exemplary", amount: 50000, quotes: [{ documentId: "D1", quote: "exemplary damages of P50,000.00" }] },
        { kind: "DAMAGE", title: "Backwages", amount: 486000, quotes: [{ documentId: "D9", quote: "backwages of P486,000.00" }] },
        { kind: "DAMAGE", title: "Backwages 2", amount: 486000, quotes: [{ documentId: "D2", quote: "backwages of P486,000.00" }] },
      ]),
      texts,
      docs,
    );
    expect(heads).to.deep.equal([]);
  });

  it("drops an entry with no title or an unknown kind, and keeps one per kind and title", () => {
    const q = [{ documentId: "D1", quote: "reinstatement to her former position" }];
    const heads = extractDamageHeads(
      reply([
        { kind: "COSTS", title: "Costs", amount: null, quotes: q },
        { kind: "REMEDY", title: "", amount: null, quotes: q },
        { kind: "REMEDY", title: "Reinstatement", amount: null, quotes: q },
        { kind: "REMEDY", title: " reinstatement", amount: null, quotes: q },
      ]),
      texts,
      docs,
    );
    expect(heads?.map((h) => h.title)).to.deep.equal(["Reinstatement"]);
  });

  it("returns undefined without a [DAMAGES] block, and [] for an empty one", () => {
    expect(extractDamageHeads("no block here", texts, docs)).to.equal(undefined);
    expect(extractDamageHeads(reply([]), texts, docs)).to.deep.equal([]);
  });
});

describe("parseDamageEstimates", () => {
  it("reads each usable estimate by title, and nothing without a block", () => {
    const estimates = parseDamageEstimates(
      `[ESTIMATES]${JSON.stringify([
        { title: "Notice Pay", amount: "5,400", basis: "12 weeks at £450." },
        { title: "Holiday pay", amount: 0, basis: "None." },
        { title: "Costs", amount: 3000 },
      ])}[/ESTIMATES]`,
    );
    expect([...estimates.entries()]).to.deep.equal([[damageHeadKey("DAMAGE", "notice pay"), { amount: 5400, basis: "12 weeks at £450." }]]);
    expect(parseDamageEstimates("nothing").size).to.equal(0);
  });
});

describe("damageHeadKey", () => {
  it("is the kind and the title, ignoring case and spacing", () => {
    expect(damageHeadKey("DAMAGE", "Moral  Damages")).to.equal(damageHeadKey("DAMAGE", "moral damages"));
    expect(damageHeadKey("DAMAGE", "Reinstatement")).to.not.equal(damageHeadKey("REMEDY", "Reinstatement"));
  });
});

describe("numbersIn", () => {
  it("reads every number, dropping thousands separators", () => {
    expect(numbersIn("P200,000.00 and 10%")).to.deep.equal([200000, 10]);
  });
});
