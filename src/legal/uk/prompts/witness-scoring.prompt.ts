import { renderWitnessScoringBody, WitnessScoringPromptData } from "../../../constants/witness-scoring.constants";

const UK_FRAMING: Record<string, string> = {
  "England and Wales": "England and Wales (witness statements under CPR Part 32, hearsay under the Civil Evidence Act 1995)",
  Scotland: "Scotland (witness statements and precognitions, hearsay under the Civil Evidence (Scotland) Act 1988)",
  "Northern Ireland": "Northern Ireland (witness statements, hearsay under the Civil Evidence Act (Northern Ireland) 1971)",
};

export function buildUKWitnessScoringPrompt(data: WitnessScoringPromptData): string {
  const framing = (data.ukJurisdiction && UK_FRAMING[data.ukJurisdiction]) || UK_FRAMING["England and Wales"];
  return `You are assessing witness credibility for a litigation team in the United Kingdom, under the rules of ${framing}. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderWitnessScoringBody(data)}`;
}
