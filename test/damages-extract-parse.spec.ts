import { expect } from "chai";
import { describe, it } from "mocha";
import { damageHeadKey, extractDamageHeads, numbersIn } from "../src/utils/damages-extract-parse";

const DOC = "D1";
const docText =
  "WHEREFORE, complainant prays for backwages of P486,000.00, moral damages of P200,000.00, and reinstatement to her former position without loss of seniority.";
const docs = new Map([[DOC, docText]]);
const reply = (rows: unknown[]) => `[DAMAGES]\n${JSON.stringify(rows)}\n[/DAMAGES]`;

describe("extractDamageHeads", () => {
  it("reads damages with the amount their quote states, and remedies with none", () => {
    const heads = extractDamageHeads(
      reply([
        { kind: "DAMAGE", title: "Backwages", description: "Unpaid wages", amount: 486000, documentId: DOC, quote: "backwages of P486,000.00" },
        {
          kind: "REMEDY",
          title: "Reinstatement",
          description: null,
          amount: null,
          documentId: DOC,
          quote: "reinstatement to her former position",
        },
      ]),
      docs,
    );
    expect(heads).to.deep.equal([
      { kind: "DAMAGE", title: "Backwages", description: "Unpaid wages", amount: 486000, documentId: DOC, quote: "backwages of P486,000.00" },
      { kind: "REMEDY", title: "Reinstatement", description: null, amount: null, documentId: DOC, quote: "reinstatement to her former position" },
    ]);
  });

  it("drops an entry whose amount isn't in its quote, whose quote isn't in the document, or that cites another document", () => {
    const heads = extractDamageHeads(
      reply([
        { kind: "DAMAGE", title: "Moral damages", amount: 250000, documentId: DOC, quote: "moral damages of P200,000.00" },
        { kind: "DAMAGE", title: "Exemplary", amount: 50000, documentId: DOC, quote: "exemplary damages of P50,000.00" },
        { kind: "DAMAGE", title: "Backwages", amount: 486000, documentId: "D9", quote: "backwages of P486,000.00" },
      ]),
      docs,
    );
    expect(heads).to.deep.equal([]);
  });

  it("drops an entry with no title or an unknown kind, and keeps one per kind and title", () => {
    const heads = extractDamageHeads(
      reply([
        { kind: "COSTS", title: "Costs", amount: null, documentId: DOC, quote: "reinstatement to her former position" },
        { kind: "REMEDY", title: "", amount: null, documentId: DOC, quote: "reinstatement to her former position" },
        { kind: "REMEDY", title: "Reinstatement", amount: null, documentId: DOC, quote: "reinstatement to her former position" },
        { kind: "REMEDY", title: " reinstatement", amount: null, documentId: DOC, quote: "reinstatement to her former position" },
      ]),
      docs,
    );
    expect(heads?.map((h) => h.title)).to.deep.equal(["Reinstatement"]);
  });

  it("returns undefined without a [DAMAGES] block, and [] for an empty one", () => {
    expect(extractDamageHeads("no block here", docs)).to.equal(undefined);
    expect(extractDamageHeads(reply([]), docs)).to.deep.equal([]);
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
