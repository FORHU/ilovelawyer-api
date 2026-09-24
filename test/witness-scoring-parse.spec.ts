import { expect } from "chai";
import { describe, it } from "mocha";
import { extractWitnessScores } from "../src/utils/witness-scoring-parse";

const known = new Set(["w1", "w2"]);
const wrap = (json: string) => `Summary text.\n[SCORES]\n${json}\n[/SCORES]`;

describe("extractWitnessScores", () => {
  it("parses a valid block", () => {
    const out = extractWitnessScores(
      wrap('[{"witnessId":"w1","credibility":72,"suggestedStatus":"ready","reasons":[{"text":"First-hand","source":"Email"}]}]'),
      known,
    );
    expect(out).to.deep.equal([
      { witnessId: "w1", credibility: 72, suggestedStatus: "READY", reasons: [{ text: "First-hand", source: "Email" }] },
    ]);
  });

  it("clamps out-of-range scores and rounds", () => {
    const out = extractWitnessScores(
      wrap('[{"witnessId":"w1","credibility":150.4,"reasons":[]},{"witnessId":"w2","credibility":-5,"reasons":[]}]'),
      known,
    )!;
    expect(out.map((s) => s.credibility)).to.deep.equal([100, 0]);
  });

  it("keeps null credibility instead of inventing a number", () => {
    const out = extractWitnessScores(wrap('[{"witnessId":"w1","credibility":null,"reasons":[{"text":"No evidence"}]}]'), known)!;
    expect(out[0].credibility).to.equal(null);
    expect(out[0].reasons[0].source).to.equal(null);
  });

  it("drops unknown and duplicate witness ids", () => {
    const out = extractWitnessScores(
      wrap('[{"witnessId":"ghost","credibility":10},{"witnessId":"w1","credibility":10},{"witnessId":"w1","credibility":90}]'),
      known,
    )!;
    expect(out).to.have.length(1);
    expect(out[0].credibility).to.equal(10);
  });

  it("ignores invalid statuses and caps reasons at four", () => {
    const reasons = Array.from({ length: 6 }, (_, i) => `{"text":"r${i}"}`).join(",");
    const out = extractWitnessScores(wrap(`[{"witnessId":"w1","credibility":50,"suggestedStatus":"MAYBE","reasons":[${reasons}]}]`), known)!;
    expect(out[0].suggestedStatus).to.equal(null);
    expect(out[0].reasons).to.have.length(4);
  });

  it("returns undefined when there is no parseable block", () => {
    expect(extractWitnessScores("no block here", known)).to.equal(undefined);
    expect(extractWitnessScores(wrap("not json"), known)).to.equal(undefined);
  });
});
