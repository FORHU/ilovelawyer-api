import { expect } from "chai";
import { describe, it } from "mocha";
import { buildNeeds } from "../src/utils/witness-needs";
import { extractWitnessFactors } from "../src/utils/witness-scoring-parse";

const full = { A: "OWN", B: "SPECIFIC", C: "WEEKS", D: "NONE", E: "CONFIRMED", F: "NONE", G: "NONE" };

describe("buildNeeds", () => {
  it("returns nothing when the statement is in and every factor is answered", () => {
    expect(buildNeeds({ statementReceived: true, sponsoredDocumentCount: 1, answers: full, aiNeeds: {} })).to.deep.equal([]);
  });

  it("asks for the statement, linked to the statement field", () => {
    const needs = buildNeeds({ statementReceived: false, sponsoredDocumentCount: 1, answers: full, aiNeeds: {} });
    expect(needs).to.have.length(1);
    expect(needs[0]).to.include({ key: "STATEMENT", link: "STATEMENT" });
  });

  it("with no sponsored document asks only for that, not for seven factors", () => {
    const needs = buildNeeds({ statementReceived: true, sponsoredDocumentCount: 0, answers: {}, aiNeeds: {} });
    expect(needs.map((n) => n.key)).to.deep.equal(["DOCUMENT"]);
    expect(needs[0].link).to.equal("EVIDENCE");
  });

  it("lists each unanswered factor, using the model's step when it gave one", () => {
    const needs = buildNeeds({
      statementReceived: true,
      sponsoredDocumentCount: 1,
      answers: { ...full, E: null, C: null },
      aiNeeds: { E: "Ask Pacific Meridian for its invoice register." },
    });
    expect(needs.map((n) => n.key)).to.deep.equal(["FACTOR_C", "FACTOR_E"]);
    expect(needs[1].text).to.equal("Ask Pacific Meridian for its invoice register.");
    expect(needs[0].text).to.contain("How soon after the events");
    expect(needs[0]).to.include({ link: "FACTOR", factor: "C" });
  });
});

describe("extractWitnessFactors needs", () => {
  const wrap = (json: string) => `x\n[SCORES]\n${json}\n[/SCORES]`;

  it("keeps one valid need per factor and drops junk", () => {
    const out = extractWitnessFactors(
      wrap('[{"witnessId":"w1","needs":[{"factor":"e","text":"Ask the bank"},{"factor":"E","text":"dup"},{"factor":"Z","text":"bad"},{"factor":"C"}]}]'),
      new Set(["w1"]),
    )!;
    expect(out[0].needs).to.deep.equal({ E: "Ask the bank" });
  });
});
