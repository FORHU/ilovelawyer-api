import { expect } from "chai";
import { describe, it } from "mocha";
import { getDeadlineEngine } from "../src/legal/deadline-engine.registry";
import { computePhilippineDeadline } from "../src/utils/ph-deadline";

describe("Deadline engine selection", () => {
  it("PH jurisdiction reproduces utils/ph-deadline.ts's existing output unchanged", () => {
    const trigger = new Date("2026-01-05T00:00:00Z");
    const direct = computePhilippineDeadline("answer_civil", trigger);
    const viaEngine = getDeadlineEngine("PH").calculate("answer_civil", trigger);

    expect(viaEngine.computedDueDate.toISOString()).to.equal(direct.computedDueDate.toISOString());
    expect(viaEngine.rule.code).to.equal(direct.rule.code);
  });

  it("UK jurisdiction only exposes UK rules, never PH ones", () => {
    const ukEngine = getDeadlineEngine("UK");
    const codes = ukEngine.listRules().map((r) => r.code);
    expect(codes).to.include("acknowledgment_of_service");
    expect(codes).to.not.include("answer_civil");

    const phEngine = getDeadlineEngine("PH");
    const phCodes = phEngine.listRules().map((r) => r.code);
    expect(phCodes).to.include("answer_civil");
    expect(phCodes).to.not.include("acknowledgment_of_service");
  });

  it("a PH rule code passed to the UK engine throws rather than silently computing", () => {
    expect(() => getDeadlineEngine("UK").calculate("answer_civil", new Date("2026-01-05"))).to.throw(/Unknown UK deadline rule/);
  });

  it("an unmapped jurisdiction throws instead of falling back to PH", () => {
    // @ts-expect-error deliberately passing an unsupported jurisdiction to prove no silent fallback
    expect(() => getDeadlineEngine("SG")).to.throw(/No deadline engine configured/);
  });

  it("every UK rule is explicitly marked LEGAL_REVIEW_REQUIRED", () => {
    const ukEngine = getDeadlineEngine("UK");
    for (const rule of ukEngine.listRules()) {
      expect(rule.ruleSource).to.include("LEGAL_REVIEW_REQUIRED");
    }
  });
});
