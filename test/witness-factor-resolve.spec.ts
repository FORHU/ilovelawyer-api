import { expect } from "chai";
import { describe, it } from "mocha";
import { FACTOR_KEYS, type FactorKey } from "../src/utils/witness-rubric";
import { parseOverrides, resolveFactors } from "../src/utils/witness-factor-resolve";
import { normalizeJevAnswer, type JevFactors } from "../src/utils/witness-rubric-jev";
import type { WitnessFactorAnswer } from "../src/utils/witness-scoring-parse";

const empty = (): Record<FactorKey, WitnessFactorAnswer> =>
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, { answer: null, quote: null, document: null }])) as Record<FactorKey, WitnessFactorAnswer>;
const noJev = (): JevFactors =>
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, { answer: null, confidence: 0, rawAnswer: null }])) as JevFactors;
const found = () => ({ verified: true, documentName: "Affidavit" });
const missing = () => ({ verified: false, documentName: null });

describe("resolveFactors", () => {
  it("counts a Chat Wonder answer only when its quote is found in the source", () => {
    const ai = empty();
    ai.A = { answer: "OWN", quote: "I saw him sign", document: "Affidavit" };
    ai.B = { answer: "SPECIFIC", quote: "made up line", document: "Affidavit" };
    const { answers, audit } = resolveFactors(ai, null, null, (q) => (q === "I saw him sign" ? found() : missing()));
    expect(answers.A).to.equal("OWN");
    expect(answers.B).to.equal(null);
    expect(audit.A.by).to.equal("AI");
    expect(audit.B.quoteVerified).to.equal(false);
  });

  it("prefers a confident Jev answer over Chat Wonder's and keeps the disagreement", () => {
    const ai = empty();
    ai.D = { answer: "NONE", quote: "q", document: null };
    const jev = noJev();
    jev.D = { answer: "MINOR", confidence: 0.9, rawAnswer: "MINOR" };
    const { answers, audit } = resolveFactors(ai, jev, null, found);
    expect(answers.D).to.equal("MINOR");
    expect(audit.D.by).to.equal("JEV");
    expect(audit.D.aiAnswer).to.equal("NONE");
  });

  it("does not fall back to Chat Wonder when Jev ran but was unsure", () => {
    const ai = empty();
    ai.F = { answer: "NONE", quote: "q", document: null };
    const jev = noJev();
    jev.F = { answer: null, confidence: 0.4, rawAnswer: "CENTRAL" };
    const { answers, audit } = resolveFactors(ai, jev, null, found);
    expect(answers.F).to.equal(null);
    expect(audit.F.by).to.equal("NONE");
    expect(audit.F.jevRawAnswer).to.equal("CENTRAL");
  });

  it("lets a lawyer override win over Jev and Chat Wonder", () => {
    const ai = empty();
    ai.G = { answer: "NONE", quote: null, document: null };
    const jev = noJev();
    jev.G = { answer: "SOME", confidence: 0.95, rawAnswer: "SOME" };
    const { answers, audit } = resolveFactors(ai, jev, { G: { answer: "DIRECT_STAKE", note: "owns shares", by: "u1", at: "t" } }, found);
    expect(answers.G).to.equal("DIRECT_STAKE");
    expect(audit.G.by).to.equal("OVERRIDE");
  });

  it("ignores an override whose answer is not a valid option", () => {
    const { answers } = resolveFactors(empty(), null, { A: { answer: "BOGUS", note: "", by: "", at: "" } }, missing);
    expect(answers.A).to.equal(null);
  });
});

describe("normalizeJevAnswer", () => {
  it("keeps a confident known option", () => {
    expect(normalizeJevAnswer("A", "OWN", 0.8).answer).to.equal("OWN");
  });

  it("drops NOT_SHOWN, unknown options and answers under the confidence floor", () => {
    expect(normalizeJevAnswer("A", "NOT_SHOWN", 0.99).answer).to.equal(null);
    expect(normalizeJevAnswer("A", "CENTRAL", 0.99).answer).to.equal(null);
    const low = normalizeJevAnswer("A", "OWN", 0.3);
    expect(low.answer).to.equal(null);
    expect(low.rawAnswer).to.equal("OWN");
  });
});

describe("parseOverrides", () => {
  it("reads stored overrides and ignores junk", () => {
    expect(parseOverrides(null)).to.equal(null);
    expect(parseOverrides({ A: { answer: "OWN", note: "n", by: "u", at: "t" }, Z: {} })).to.deep.equal({
      A: { answer: "OWN", note: "n", by: "u", at: "t" },
    });
  });
});
