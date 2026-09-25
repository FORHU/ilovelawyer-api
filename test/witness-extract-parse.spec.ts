import { expect } from "chai";
import { describe, it } from "mocha";
import { extractWitnesses, witnessNameKey } from "../src/utils/witness-extract-parse";

const docs = new Map([
  ["d1", "AFFIDAVIT\nI, Maria  Santos, of legal age,\nwitnessed the collision on 3 May 2024."],
  ["d2", "From: John O’Brien\nTo: Claims team\nThe van was parked outside."],
]);
const wrap = (json: string) => `[WITNESSES]\n${json}\n[/WITNESSES]`;

describe("extractWitnesses", () => {
  it("keeps an entry whose quote is in the cited document, tolerating reflowed whitespace", () => {
    const out = extractWitnesses(
      wrap('[{"name":"Maria Santos","role":"Eyewitness","summary":"Saw the collision.","documentId":"d1","quote":"I, Maria Santos, of legal age, witnessed the collision"}]'),
      docs,
    );
    expect(out).to.deep.equal([
      {
        name: "Maria Santos",
        role: "Eyewitness",
        summary: "Saw the collision.",
        documentId: "d1",
        quote: "I, Maria Santos, of legal age, witnessed the collision",
      },
    ]);
  });

  it("matches straight quotes against curly ones in the document", () => {
    const out = extractWitnesses(wrap('[{"name":"John O\'Brien","documentId":"d2","quote":"From: John O\'Brien"}]'), docs)!;
    expect(out).to.have.length(1);
    expect(out[0].role).to.equal(null);
  });

  it("drops a quote that is not in the document, or cites the wrong or an unknown document", () => {
    const out = extractWitnesses(
      wrap(
        '[{"name":"Pedro Reyes","documentId":"d1","quote":"Pedro Reyes saw everything"},' +
          '{"name":"Maria Santos","documentId":"d2","quote":"I, Maria Santos, of legal age"},' +
          '{"name":"Maria Santos","documentId":"ghost","quote":"I, Maria Santos, of legal age"}]',
      ),
      docs,
    )!;
    expect(out).to.deep.equal([]);
  });

  it("drops quotes that are too short to verify", () => {
    const out = extractWitnesses(wrap('[{"name":"Maria","documentId":"d1","quote":"Maria"}]'), docs)!;
    expect(out).to.deep.equal([]);
  });

  it("dedupes the same person by normalized name", () => {
    const out = extractWitnesses(
      wrap(
        '[{"name":"Maria Santos","documentId":"d1","quote":"I, Maria Santos, of legal age"},' +
          '{"name":"Ms. maria santos","documentId":"d1","quote":"witnessed the collision on 3 May 2024"}]',
      ),
      docs,
    )!;
    expect(out).to.have.length(1);
  });

  it("returns undefined without a block and [] for an empty one", () => {
    expect(extractWitnesses("No witnesses found.", docs)).to.equal(undefined);
    expect(extractWitnesses(wrap("[]"), docs)).to.deep.equal([]);
  });
});

describe("witnessNameKey", () => {
  it("ignores honorifics, case and punctuation", () => {
    expect(witnessNameKey("Atty. Juan  Dela Cruz")).to.equal(witnessNameKey("juan dela cruz"));
    expect(witnessNameKey("Dr. Ana Lim")).to.not.equal(witnessNameKey("Ana Lima"));
  });
});
