import { expect } from "chai";
import { describe, it } from "mocha";
import { FACTOR_KEYS, scoreWitness, type FactorKey } from "../src/utils/witness-rubric";
import { buildNeeds } from "../src/utils/witness-needs";
import { recomputeFromStored, type StoredFactors } from "../src/utils/witness-recompute";
import type { FactorAudit } from "../src/utils/witness-factor-resolve";

function audit(answer: string | null): FactorAudit {
  return { answer, by: answer ? "JEV" : "NONE", confidence: 0.9, quote: null, quoteVerified: false, documentName: null };
}

/** A stored row as scoring writes it: A, B, D, F, G answered; C and E not shown in the papers. */
function stored(): StoredFactors {
  const answers: Record<FactorKey, string | null> = { A: "OWN", B: "SPECIFIC", C: null, D: "NONE", E: null, F: "NONE", G: "NONE" };
  const factors = Object.fromEntries(FACTOR_KEYS.map((k) => [k, audit(answers[k])])) as Record<FactorKey, FactorAudit>;
  const r = scoreWitness(answers, true);
  return {
    factors,
    earned: r.earned,
    assessable: r.assessable,
    band: r.band,
    flags: r.flags,
    insufficientReason: r.insufficientReason,
    needs: buildNeeds({ statementReceived: true, sponsoredDocumentCount: 1, answers, aiNeeds: { E: "Ask the bank for the ledger." } }),
    aiNeeds: { E: "Ask the bank for the ledger." },
    sponsoredDocumentCount: 1,
  };
}

const ov = (answer: string) => ({ answer, note: "checked with the client", by: "u1", at: "2026-09-25T10:00:00.000Z" });

describe("recomputeFromStored", () => {
  it("setting an unanswered factor raises coverage and removes it from the needs list", () => {
    const before = stored();
    expect(before.needs.map((n) => n.key)).to.deep.equal(["FACTOR_C", "FACTOR_E"]);
    const next = recomputeFromStored(before, { E: ov("CONFIRMED") }, true);
    expect(next.aiFactors.assessable).to.equal(before.assessable + 20);
    expect(next.aiFactors.needs.map((n) => n.key)).to.deep.equal(["FACTOR_C"]);
    expect(next.aiFactors.factors.E.overriddenTo).to.equal("CONFIRMED");
    // the app's own finding is kept
    expect(next.aiFactors.factors.E.answer).to.equal(null);
  });

  it("overriding an answered factor changes the score, flags and suggested status", () => {
    const next = recomputeFromStored(stored(), { F: ov("CENTRAL") }, true);
    expect(next.aiFactors.flags).to.include("CENTRAL_CONTRADICTION");
    expect(next.aiSuggestedStatus).to.equal("ADVERSE");
    expect(next.aiCredibility).to.be.lessThan(scoreWitness({ A: "OWN", B: "SPECIFIC", D: "NONE", F: "NONE", G: "NONE" }, true).score as number);
  });

  it("clearing every override restores exactly what scoring produced", () => {
    const base = stored();
    const withOverride = recomputeFromStored(base, { F: ov("CENTRAL") }, true);
    const cleared = recomputeFromStored(withOverride.aiFactors, null, true);
    const original = recomputeFromStored(base, null, true);
    expect(cleared.aiCredibility).to.equal(original.aiCredibility);
    expect(cleared.aiSuggestedStatus).to.equal(original.aiSuggestedStatus);
    expect(cleared.aiFactors.factors.F.overriddenTo).to.equal(undefined);
  });

  it("recovers the model's next steps for a row scored before they were kept", () => {
    const old = stored();
    delete old.aiNeeds;
    delete old.sponsoredDocumentCount;
    const next = recomputeFromStored(old, { C: ov("WEEKS") }, true);
    const e = next.aiFactors.needs.find((n) => n.key === "FACTOR_E");
    expect(e?.text).to.equal("Ask the bank for the ledger.");
  });

  it("counts a low-confidence answer for review only while a lawyer has not set it", () => {
    const s = stored();
    s.factors.D = { ...s.factors.D, lowConfidence: true };
    expect(recomputeFromStored(s, null, true).aiFactors.reviewCount).to.equal(1);
    expect(recomputeFromStored(s, { D: ov("MINOR") }, true).aiFactors.reviewCount).to.equal(0);
  });

  it("offers the factor's question and options on a needs item so the panel can ask for it", () => {
    const item = stored().needs.find((n) => n.key === "FACTOR_C");
    expect(item?.question).to.contain("How soon after the events");
    expect(item?.options?.map((o) => o.value)).to.deep.equal(["WEEKS", "MONTHS", "OVER_YEAR"]);
  });
});

import { describeOverrides } from "../src/utils/witness-recompute";

describe("describeOverrides", () => {
  it("lists a lawyer's answers in plain words for the panel", () => {
    const list = describeOverrides({ E: ov("CONFIRMED") });
    expect(list).to.have.length(1);
    expect(list[0].factor).to.equal("E");
    expect(list[0].label).to.equal("Corroboration");
    expect(list[0].answerLabel).to.contain("independent documents");
    expect(list[0].note).to.equal("checked with the client");
  });

  it("is empty when nothing is set, and recompute carries it", () => {
    expect(describeOverrides(null)).to.deep.equal([]);
    expect(recomputeFromStored(stored(), { E: ov("CONFIRMED") }, true).aiFactors.overrideList).to.have.length(1);
  });
});
