import { expect } from "chai";
import { describe, it } from "mocha";
import { parseDecisionsPayload } from "../src/utils/response-parser";

const ONE_RECORD = {
  anchor: "The absence of the through-ties was a substantial cause of the collapse.",
  conclusion: "The missing ties caused the collapse.",
  rule: [{ title: "CMCHA 2007, s 1", url: "https://juris.ph/case/abc", verified: true }],
  evidenceFor: [{ doc: "D01", docId: "doc-1", pinpoint: "para 10", quote: "east tie line", verified: true }],
  evidenceAgainst: [],
  alternatives: [{ position: "Wind alone", whyRejected: "would have survived a tied bay", evidenceRef: "D20.1" }],
  weighting: "The survey outweighs disputed recollection.",
  confidence: "high",
  wouldChangeIf: ["The ties were found intact"],
};

describe("parseDecisionsPayload", () => {
  it("parses a well-formed decisions envelope", () => {
    const parsed = parseDecisionsPayload({ records: [ONE_RECORD] });
    expect(parsed).to.not.be.undefined;
    expect(parsed!.records).to.have.length(1);
    const r = parsed!.records[0];
    expect(r.anchor).to.equal(ONE_RECORD.anchor);
    expect(r.rule).to.deep.equal([{ title: "CMCHA 2007, s 1", url: "https://juris.ph/case/abc", verified: true }]);
    expect(r.evidenceFor[0]).to.deep.equal({ doc: "D01", docId: "doc-1", pinpoint: "para 10", quote: "east tie line", verified: true });
    expect(r.confidence).to.equal("high");
    expect(r.wouldChangeIf).to.deep.equal(["The ties were found intact"]);
  });

  it("returns undefined for non-object / array top-level data", () => {
    expect(parseDecisionsPayload(null)).to.be.undefined;
    expect(parseDecisionsPayload("a string")).to.be.undefined;
    expect(parseDecisionsPayload([ONE_RECORD])).to.be.undefined;
  });

  it("returns undefined when records is missing or not an array", () => {
    expect(parseDecisionsPayload({})).to.be.undefined;
    expect(parseDecisionsPayload({ records: "not an array" })).to.be.undefined;
  });

  it("returns undefined when every record is missing anchor/conclusion", () => {
    expect(parseDecisionsPayload({ records: [{ conclusion: "x" }, { anchor: "" }] })).to.be.undefined;
  });

  it("drops individually malformed records but keeps the well-formed ones", () => {
    const parsed = parseDecisionsPayload({ records: [ONE_RECORD, "garbage", 42, { anchor: "no conclusion field" }] });
    expect(parsed!.records).to.have.length(1);
  });

  it("defaults missing/invalid confidence to medium and missing arrays to []", () => {
    const parsed = parseDecisionsPayload({ records: [{ anchor: "a.", conclusion: "b" }] });
    const r = parsed!.records[0];
    expect(r.confidence).to.equal("medium");
    expect(r.rule).to.deep.equal([]);
    expect(r.evidenceFor).to.deep.equal([]);
    expect(r.evidenceAgainst).to.deep.equal([]);
    expect(r.alternatives).to.deep.equal([]);
    expect(r.wouldChangeIf).to.deep.equal([]);
  });

  it("never re-derives verified — passes through exactly what chat-wonder audited", () => {
    const unverified = { ...ONE_RECORD, rule: [{ title: "Invented Case", url: null, verified: false }] };
    const parsed = parseDecisionsPayload({ records: [unverified] });
    expect(parsed!.records[0].rule).to.deep.equal([{ title: "Invented Case", url: null, verified: false }]);
  });

  it("filters non-string entries out of wouldChangeIf", () => {
    const parsed = parseDecisionsPayload({ records: [{ ...ONE_RECORD, wouldChangeIf: ["ok", 5, null, "also ok"] }] });
    expect(parsed!.records[0].wouldChangeIf).to.deep.equal(["ok", "also ok"]);
  });
});
