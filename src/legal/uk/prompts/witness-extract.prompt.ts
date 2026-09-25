import { renderWitnessExtractBody, WitnessExtractPromptData } from "../../../constants/witness-extract.constants";

export function buildUKWitnessExtractPrompt(data: WitnessExtractPromptData): string {
  const venue = data.ukJurisdiction || "England and Wales";
  return `You are identifying potential witnesses of fact for a litigation team in the United Kingdom (${venue}). Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderWitnessExtractBody(data)}`;
}
