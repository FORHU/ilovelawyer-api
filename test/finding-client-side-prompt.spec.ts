import { expect } from "chai";
import { describe, it } from "mocha";
import { buildUKCaseFindingPrompt } from "../src/legal/uk/prompts/case-finding.prompt";
import { buildCaseFindingPrompt } from "../src/constants/case-finding.constants";
import { caseDataState } from "../src/utils/case-jev-context";
import { RESPONDENT_SEVERITY_LEVELS, SEVERITY_LEVELS } from "../src/utils/weakness-jev";
import { RESPONDENT_WEIGHT_LEVELS, WEIGHT_LEVELS } from "../src/utils/strength-jev";

const docs = [{ id: "doc-1", name: "MG11 Sheila Brandon" }];

describe("findings prompt client side", () => {
  it("keeps the claimant framing when the side isn't set", () => {
    const prompt = buildUKCaseFindingPrompt(docs, "England and Wales", null);
    expect(prompt).to.not.include("## CLIENT");
    expect(prompt).to.include("as the claimant/applicant party");
  });

  it("reads the case from the defence when the client is the respondent", () => {
    const prompt = buildUKCaseFindingPrompt(docs, "England and Wales", "RESPONDENT");
    expect(prompt).to.include("## CLIENT");
    expect(prompt).to.include("the accused");
    expect(prompt).to.include("never a Weakness");
    expect(prompt).to.include("advance this case as your client");
    expect(prompt).to.not.include("as the claimant/applicant party");
  });

  it("applies to the PH prompt too, without changing its output blocks", () => {
    const prompt = buildCaseFindingPrompt(docs, null, "CLAIMANT");
    expect(prompt).to.include("You act for the CLAIMANT");
    expect(prompt).to.include("[WEAKNESSES]");
    expect(buildCaseFindingPrompt(docs)).to.include("as the moving/complaining party");
  });
});

describe("Jev case data client side", () => {
  const base = { opponent: null, legalIssues: [], weaknesses: [], contradictions: [], timeline: [], witnesses: [], parties: [] };

  it("tells the finding checks which side the user acts for", () => {
    expect(caseDataState({ ...base, clientSide: "RESPONDENT" }).userSide).to.include("respondent");
    expect(caseDataState({ ...base, clientSide: "CLAIMANT" }).userSide).to.include("claimant");
  });

  it("leaves the case data as it was when the side isn't set", () => {
    expect(caseDataState({ ...base, clientSide: null })).to.not.have.property("userSide");
    expect(caseDataState(base)).to.not.have.property("userSide");
  });

  it("has defence severity and weight scales the same length as the claimant ones", () => {
    expect(RESPONDENT_SEVERITY_LEVELS).to.have.length(SEVERITY_LEVELS.length);
    expect(RESPONDENT_WEIGHT_LEVELS).to.have.length(WEIGHT_LEVELS.length);
  });

  it("tells a defending client that missing evidence on the other side is a Strength", () => {
    const docs = [{ id: "doc-1", name: "Forensic report" }];
    expect(buildUKCaseFindingPrompt(docs, null, "RESPONDENT")).to.include("no forensic link to your client");
    expect(buildUKCaseFindingPrompt(docs, null, "CLAIMANT")).to.not.include("no forensic link");
  });
});
