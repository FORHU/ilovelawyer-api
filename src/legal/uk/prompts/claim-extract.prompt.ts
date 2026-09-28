import { renderClaimExtractBody, ClaimExtractPromptData } from "../../../constants/claim-extract.constants";

export function buildUKClaimExtractPrompt(data: ClaimExtractPromptData): string {
  const venue = data.ukJurisdiction || "England and Wales";
  return `You are identifying the pleaded claims for a litigation team in the United Kingdom (${venue}). Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderClaimExtractBody(data)}`;
}
