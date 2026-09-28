import { expect } from "chai";
import { describe, it } from "mocha";
import { extractCaseFindings } from "../src/utils/case-finding-parse";

const reply = (issues: unknown[], weaknesses: unknown[] = []) =>
  `[LEGAL_ISSUES]\n${JSON.stringify(issues)}\n[/LEGAL_ISSUES]\n[WEAKNESSES]\n${JSON.stringify(weaknesses)}\n[/WEAKNESSES]`;

describe("extractCaseFindings", () => {
  it("reads detail, status and burden on legal issues", () => {
    const [issue] = extractCaseFindings(
      reply([
        {
          label: "Was the abandonment claim substantiated?",
          sourceLabel: "Termination letter",
          detail: "Employer bears the burden on just cause",
          burden: "respondent",
          status: "contested",
        },
      ]),
    )!;
    expect(issue).to.deep.equal({
      category: "LEGAL_ISSUE",
      label: "Was the abandonment claim substantiated?",
      sourceLabel: "Termination letter",
      detail: "Employer bears the burden on just cause",
      tag: "CONTESTED",
      burden: "RESPONDENT",
    });
  });

  it("drops a status the category can't use, and an UNCLEAR or unknown burden", () => {
    const found = extractCaseFindings(
      reply([
        { label: "One", status: "MATERIAL", burden: "UNCLEAR" },
        { label: "Two", status: "RESOLVED", burden: "the employer" },
      ]),
    )!;
    expect(found.map((f) => [f.tag, f.burden])).to.deep.equal([
      [null, null],
      ["RESOLVED", null],
    ]);
  });

  it("only keeps a burden on legal issues", () => {
    const [, weakness] = extractCaseFindings(reply([{ label: "Issue" }], [{ label: "Gap", burden: "CLAIMANT" }]))!;
    expect(weakness).to.include({ category: "WEAKNESS", burden: null });
  });

  it("still reads the older string and {label, sourceLabel} items", () => {
    const found = extractCaseFindings(reply(["Plain issue", { label: "Object issue", sourceLabel: "D1" }]))!;
    expect(found).to.deep.equal([
      { category: "LEGAL_ISSUE", label: "Plain issue", sourceLabel: null, detail: null, tag: null, burden: null },
      { category: "LEGAL_ISSUE", label: "Object issue", sourceLabel: "D1", detail: null, tag: null, burden: null },
    ]);
  });

  it("caps detail at 160 characters", () => {
    const [issue] = extractCaseFindings(reply([{ label: "Issue", detail: "x".repeat(300) }]))!;
    expect(issue.detail).to.have.length(160);
  });
});
