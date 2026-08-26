import { expect } from "chai";
import { describe, it } from "mocha";
import {
  getRedTeamPromptBuilder,
  getCaseFindingPromptBuilder,
  getCaseReconstructionPromptBuilder,
  getCaseStrategyPromptBuilder,
  getSourceAnalysisPromptTemplate,
  getChatTitlePromptBuilder,
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
