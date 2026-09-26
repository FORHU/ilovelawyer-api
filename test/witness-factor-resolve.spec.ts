import { expect } from "chai";
import { describe, it } from "mocha";
import { FACTOR_KEYS, type FactorKey } from "../src/utils/witness-rubric";
import { parseOverrides, resolveFactors } from "../src/utils/witness-factor-resolve";
import { normalizeJevAnswer, type JevFactors } from "../src/utils/witness-rubric-jev";
import type { WitnessFactorAnswer } from "../src/utils/witness-scoring-parse";

const empty = (): Record<FactorKey, WitnessFactorAnswer> =>
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, { answer: null, quote: null, document: null }])) as Record<FactorKey, WitnessFactorAnswer>;
const noJev = (): JevFactors =>
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, { answer: null, confidence: 0, rawAnswer: null, lowConfidence: false }])) as JevFactors;
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

  it("prefers Jev's answer over Chat Wonder's and keeps the disagreement", () => {
    const ai = empty();
    ai.D = { answer: "NONE", quote: "q", document: null };
    const jev = noJev();
    jev.D = { answer: "MINOR", confidence: 0.9, rawAnswer: "MINOR", lowConfidence: false };
    const { answers, audit } = resolveFactors(ai, jev, null, found);
    expect(answers.D).to.equal("MINOR");
    expect(audit.D.by).to.equal("JEV");
    expect(audit.D.aiAnswer).to.equal("NONE");
  });

  it("counts a Jev answer even when it is unsure, and flags it for the lawyer", () => {
    const jev = noJev();
    jev.F = { answer: "CENTRAL", confidence: 0.4, rawAnswer: "CENTRAL", lowConfidence: true };
    const { answers, audit } = resolveFactors(empty(), jev, null, missing);
    expect(answers.F).to.equal("CENTRAL");
    expect(audit.F.lowConfidence).to.equal(true);
  });

  it("does not fall back to Chat Wonder when Jev says the papers do not show it", () => {
    const ai = empty();
    ai.F = { answer: "NONE", quote: "q", document: null };
    const jev = noJev();
    jev.F = { answer: null, confidence: 0.9, rawAnswer: "NOT_SHOWN", lowConfidence: false };
    const { answers, audit } = resolveFactors(ai, jev, null, found);
    expect(answers.F).to.equal(null);
    expect(audit.F.by).to.equal("NONE");
    expect(audit.F.jevRawAnswer).to.equal("NOT_SHOWN");
  });

  it("lets a lawyer override win, and keeps what the app itself found", () => {
    const ai = empty();
    ai.G = { answer: "NONE", quote: null, document: null };
    const jev = noJev();
    jev.G = { answer: "SOME", confidence: 0.95, rawAnswer: "SOME", lowConfidence: false };
    const { answers, audit } = resolveFactors(ai, jev, { G: { answer: "DIRECT_STAKE", note: "owns shares", by: "u1", at: "t" } }, found);
    expect(answers.G).to.equal("DIRECT_STAKE");
    expect(audit.G.answer).to.equal("SOME");
    expect(audit.G.by).to.equal("JEV");
    expect(audit.G.overriddenTo).to.equal("DIRECT_STAKE");
  });

  it("ignores an override whose answer is not a valid option", () => {
    const { answers, audit } = resolveFactors(empty(), null, { A: { answer: "BOGUS", note: "", by: "", at: "" } }, missing);
    expect(answers.A).to.equal(null);
    expect(audit.A.overriddenTo).to.equal(undefined);
  });
});

describe("normalizeJevAnswer", () => {
  it("keeps a known option and does not flag a confident one", () => {
    const a = normalizeJevAnswer("A", "OWN", 0.8);
    expect(a.answer).to.equal("OWN");
    expect(a.lowConfidence).to.equal(false);
  });

  it("keeps an unsure answer but flags it for review", () => {
    const low = normalizeJevAnswer("A", "OWN", 0.3);
    expect(low.answer).to.equal("OWN");
    expect(low.lowConfidence).to.equal(true);
  });

  it("drops NOT_SHOWN and unknown options, which are never flagged", () => {
    const shown = normalizeJevAnswer("A", "NOT_SHOWN", 0.99);
    expect(shown.answer).to.equal(null);
    expect(shown.lowConfidence).to.equal(false);
    expect(normalizeJevAnswer("A", "CENTRAL", 0.99).answer).to.equal(null);
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
