import { expect } from "chai";
import { describe, it } from "mocha";
import { bandFor, FACTOR_KEYS, RUBRIC, scoreWitness } from "../src/utils/witness-rubric";

const best = { A: "OWN", B: "SPECIFIC", C: "WEEKS", D: "NONE", E: "CONFIRMED", F: "NONE", G: "NONE" };

describe("witness rubric", () => {
  it("weights add up to 100", () => {
    const total = FACTOR_KEYS.reduce((sum, k) => sum + Math.max(...Object.values(RUBRIC[k].options)), 0);
    expect(total).to.equal(100);
  });

  it("scores the best answers 100 / HIGH / READY", () => {
    const r = scoreWitness(best, true);
    expect(r.score).to.equal(100);
    expect(r.band).to.equal("HIGH");
    expect(r.suggestedStatus).to.equal("READY");
    expect(r.flags).to.deep.equal([]);
  });

  it("is deterministic for the same answers", () => {
    expect(scoreWitness(best, true)).to.deep.equal(scoreWitness({ ...best }, true));
  });

  it("treats not-assessable as excluded, not zero", () => {
    const r = scoreWitness({ ...best, C: null, E: null }, true);
    expect(r.assessable).to.equal(70);
    expect(r.earned).to.equal(70);
    expect(r.score).to.equal(100);
  });

  it("gives no score when factor A or D is not assessable", () => {
    const r = scoreWitness({ ...best, A: null }, true);
    expect(r.score).to.equal(null);
    expect(r.band).to.equal(null);
    expect(r.insufficientReason).to.contain("Basis of knowledge");
    expect(r.suggestedStatus).to.equal("OUTSTANDING");
  });

  it("gives no score under 60 assessable points", () => {
    // A 20 + D 15 + B 10 + C 10 = 55
    const r = scoreWitness({ A: "OWN", D: "NONE", B: "SPECIFIC", C: "WEEKS" }, true);
    expect(r.assessable).to.equal(55);
    expect(r.score).to.equal(null);
  });

  it("treats an unknown option as not assessable", () => {
    const r = scoreWitness({ ...best, B: "BOGUS" }, true);
    expect(r.factors.B.points).to.equal(null);
    expect(r.factors.B.answer).to.equal(null);
  });

  it("flags a central contradiction and suggests ADVERSE even on a high score", () => {
    const r = scoreWitness({ ...best, F: "CENTRAL" }, true);
    expect(r.score).to.equal(85);
    expect(r.flags).to.include("CENTRAL_CONTRADICTION");
    expect(r.suggestedStatus).to.equal("ADVERSE");
  });

  it("suggests ADVERSE for a Weak band", () => {
    const r = scoreWitness(
      { A: "REPORTED", B: "VAGUE", C: "OVER_YEAR", D: "MATERIAL", E: "UNSUPPORTED", F: "PERIPHERAL", G: "SOME" },
      true,
    );
    expect(r.band).to.equal("WEAK");
    expect(r.flags).to.include("MAINLY_HEARSAY");
    expect(r.suggestedStatus).to.equal("ADVERSE");
  });

  it("suggests OUTSTANDING when no statement has been received, and flags it", () => {
    const r = scoreWitness(best, false);
    expect(r.flags).to.deep.equal(["STATEMENT_NOT_RECEIVED"]);
    expect(r.suggestedStatus).to.equal("OUTSTANDING");
  });

  it("flags a direct stake without changing the score", () => {
    const r = scoreWitness({ ...best, G: "DIRECT_STAKE" }, true);
    expect(r.flags).to.deep.equal(["DIRECT_STAKE"]);
    expect(r.score).to.equal(90);
  });

  it("suggests ADVERSE for a Low band with a statement in hand", () => {
    // 20+5+5+8+0+8+5 = 51 of 100
    const r = scoreWitness(
      { A: "OWN", B: "SOME", C: "MONTHS", D: "MINOR", E: "UNSUPPORTED", F: "PERIPHERAL", G: "SOME" },
      true,
    );
    expect(r.band).to.equal("LOW");
    expect(r.suggestedStatus).to.equal("ADVERSE");
  });

  it("puts band boundaries at 75 / 55 / 35", () => {
    expect(bandFor(75)).to.equal("HIGH");
    expect(bandFor(74)).to.equal("MODERATE");
    expect(bandFor(55)).to.equal("MODERATE");
    expect(bandFor(54)).to.equal("LOW");
    expect(bandFor(35)).to.equal("LOW");
    expect(bandFor(34)).to.equal("WEAK");
  });
});
