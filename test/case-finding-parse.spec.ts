import { expect } from "chai";
import { describe, it } from "mocha";
import { extractCaseFindings } from "../src/utils/case-finding-parse";

describe("case finding parse — readiness", () => {
  it("reads readiness/readinessNote on ATTACK_STRATEGY/DEFENSE_STRATEGY only", () => {
    const text = `
[LEGAL_ISSUES]
[{"label": "Was there just cause?", "sourceLabel": null}]
[/LEGAL_ISSUES]

[WEAKNESSES]
[]
[/WEAKNESSES]

[STRENGTHS]
[]
[/STRENGTHS]

[ATTACK_STRATEGY]
[{"label": "Rebut abandonment with the payroll series", "sourceLabel": "Payroll.pdf", "readiness": "blocked", "readinessNote": "Certification not yet obtained"}]
[/ATTACK_STRATEGY]

[DEFENSE_STRATEGY]
[{"label": "Press the twin-notice gap independently", "sourceLabel": null, "readiness": "READY", "readinessNote": "Ready for the position paper"}]
[/DEFENSE_STRATEGY]
`;
    const parsed = extractCaseFindings(text);
    expect(parsed).to.not.equal(undefined);

    const issue = parsed!.find((f) => f.category === "LEGAL_ISSUE")!;
    expect(issue.readiness).to.equal(null);

    const attack = parsed!.find((f) => f.category === "ATTACK_STRATEGY")!;
    expect(attack.readiness).to.equal("BLOCKED");
    expect(attack.readinessNote).to.equal("Certification not yet obtained");

    const defense = parsed!.find((f) => f.category === "DEFENSE_STRATEGY")!;
    expect(defense.readiness).to.equal("READY");
  });

  it("defaults a missing/invalid readiness to DRAFTING for attack/defense items", () => {
    const text = `
[ATTACK_STRATEGY]
[{"label": "Press the point independently", "sourceLabel": null}]
[/ATTACK_STRATEGY]

[DEFENSE_STRATEGY]
[{"label": "Hold the line on notice", "sourceLabel": null, "readiness": "NOT_A_REAL_VALUE"}]
[/DEFENSE_STRATEGY]
`;
    const parsed = extractCaseFindings(text);
    expect(parsed!.find((f) => f.category === "ATTACK_STRATEGY")!.readiness).to.equal("DRAFTING");
    expect(parsed!.find((f) => f.category === "DEFENSE_STRATEGY")!.readiness).to.equal("DRAFTING");
  });
});
