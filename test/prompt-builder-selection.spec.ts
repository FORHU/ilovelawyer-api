import { expect } from "chai";
import { buildDamagesEstimatePrompt } from "../src/constants/damages-extract.constants";
import { describe, it } from "mocha";
import {
  getRedTeamPromptBuilder,
  getCaseFindingPromptBuilder,
  getCaseReconstructionPromptBuilder,
  getCaseStrategyPromptBuilder,
  getSourceAnalysisPromptTemplate,
  getChatTitlePromptBuilder,
  getDamagesExtractPromptBuilder,
} from "../src/legal/prompt-registry";

const emptyRedTeamData = {
  caseName: "Test Case",
  parties: [],
  legalIssues: [],
  weaknesses: [],
  documents: [],
  timeline: [],
  contradictions: [],
  witnesses: [],
  damages: [],
};
const docs = [{ id: "d1", name: "Exhibit A" }];

describe("Prompt builder jurisdiction selection", () => {
  it("PH tenant's red-team prompt is PH-framed and excludes UK framing", () => {
    const prompt = getRedTeamPromptBuilder("PH")(emptyRedTeamData);
    expect(prompt).to.include("Philippine");
    expect(prompt).to.not.include("England & Wales");
  });

  it("UK tenant's red-team prompt is UK-framed and excludes PH framing", () => {
    const prompt = getRedTeamPromptBuilder("UK")(emptyRedTeamData);
    expect(prompt).to.include("England & Wales");
    expect(prompt).to.not.include("Philippine");
    expect(prompt).to.include("LEGAL_REVIEW_REQUIRED");
  });

  it("case-finding, case-reconstruction, and case-strategy prompts diverge by jurisdiction", () => {
    expect(getCaseFindingPromptBuilder("PH")(docs)).to.include("Philippine");
    expect(getCaseFindingPromptBuilder("UK")(docs)).to.include("England & Wales");

    expect(getCaseReconstructionPromptBuilder("PH")(docs)).to.include("Philippine");
    expect(getCaseReconstructionPromptBuilder("UK")(docs)).to.include("England & Wales");

    expect(getCaseStrategyPromptBuilder("PH")(docs)).to.include("Philippine");
    expect(getCaseStrategyPromptBuilder("UK")(docs)).to.include("England & Wales");
  });

  it("preserves the shared output block contract across jurisdictions (parsers depend on this)", () => {
    for (const jurisdiction of ["PH", "UK"] as const) {
      const prompt = getCaseFindingPromptBuilder(jurisdiction)(docs);
      expect(prompt).to.include("[LEGAL_ISSUES]");
      expect(prompt).to.include("[DEFENSE_STRATEGY]");
    }
  });

  it("damages-extract prompts diverge by jurisdiction but share the [DAMAGES] contract", () => {
    const data = { caseName: "Cruz v. Acme", existingHeads: [], documents: [{ id: "d1", name: "Payslip", text: "Salary: P27,000" }] };
    const ph = getDamagesExtractPromptBuilder("PH")(data);
    const uk = getDamagesExtractPromptBuilder("UK")(data);
    expect(ph).to.include("Philippines").and.to.include("13th month pay");
    expect(uk).to.include("United Kingdom").and.to.include("injury to feelings");
    for (const prompt of [ph, uk]) {
      expect(prompt).to.include("[DAMAGES]").and.to.include("[/DAMAGES]");
      expect(prompt).to.include("Never multiply or add up a figure yourself");
      expect(prompt).to.include('"calculation"').and.to.include("even when no figure is given");
      expect(prompt).to.include('"estimate" is required for every DAMAGE').and.to.include("shown to the lawyer as an AI estimate");
    }
    expect(uk).to.include("a basic award and a compensatory award");
    expect(ph).to.include("illegal dismissal — backwages");
  });

  it("damages estimate prompt asks for every listed damage in an [ESTIMATES] block", () => {
    const prompt = buildDamagesEstimatePrompt({
      caseName: "Bennett v. Meridian",
      venue: "England and Wales",
      heads: [{ title: "Notice pay", description: null, quote: "You will receive 12 weeks' notice." }],
      documents: [{ id: "D1", name: "Letter.pdf", text: "..." }],
    });
    expect(prompt).to.include("- Notice pay (claimed in: \"You will receive 12 weeks' notice.\")");
    expect(prompt).to.include("none may be left out").and.to.include("[ESTIMATES]").and.to.include("--- DOCUMENT D1 | name: Letter.pdf ---");
  });

  it("source-analysis prompt template diverges by jurisdiction", () => {
    expect(getSourceAnalysisPromptTemplate("PH")).to.include("Philippine");
    expect(getSourceAnalysisPromptTemplate("UK")).to.include("England & Wales");
  });

  it("chat title prompt diverges by jurisdiction", () => {
    expect(getChatTitlePromptBuilder("PH")("test message")).to.include("Philippine");
    expect(getChatTitlePromptBuilder("UK")("test message")).to.include("England & Wales");
  });

  it("throws rather than silently falling back for an unmapped jurisdiction", () => {
    // @ts-expect-error deliberately unsupported
    expect(() => getRedTeamPromptBuilder("SG")).to.throw(/No red-team prompt builder configured/);
  });
});
