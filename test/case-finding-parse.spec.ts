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

  it("drops a status the category can't use or only the lawyer sets, and an UNCLEAR or unknown burden", () => {
    const found = extractCaseFindings(
      reply([
        { label: "One", status: "MATERIAL", burden: "UNCLEAR" },
        { label: "Two", status: "RESOLVED", burden: "the employer" },
        { label: "Three", status: "open", burden: "shared" },
      ]),
    )!;
    expect(found.map((f) => [f.tag, f.burden])).to.deep.equal([
      [null, null],
      [null, null],
      ["OPEN", "SHARED"],
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

  it("caps detail at 300 characters, marked with an ellipsis", () => {
    const [issue] = extractCaseFindings(reply([{ label: "Issue", detail: "x".repeat(500) }]))!;
    expect(issue.detail).to.have.length(300);
    expect(issue.detail!.endsWith("…")).to.equal(true);
  });

  it("keeps a label up to 400 characters, and shortens a longer one at a word boundary", () => {
    const long = "The seller supplied goods that were not of satisfactory quality and unsanded or unpainted ".repeat(6);
    const [issue] = extractCaseFindings(reply([{ label: long }]))!;
    expect(issue.label.length).to.be.at.most(400);
    expect(issue.label.endsWith("…")).to.equal(true);
    expect(issue.label).to.not.match(/\s…$/);
    const [short] = extractCaseFindings(reply([{ label: "x".repeat(200) }]))!;
    expect(short.label).to.have.length(200);
  });
});
