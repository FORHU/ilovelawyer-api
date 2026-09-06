import LawRepo from "../repositories/law.repository";
import { extractCaseUri } from "./uk-citation-resolution";
import { grepJudgment } from "./uk-legal-mcp";
import logger from "./logger";

/** Pure, unit-testable: turns a judgment eId (e.g. "para_4") into a display pinpoint. Kept
 * separate from the I/O in detectPinpoint below. */
export function formatPinpointFromEid(eId: string): string {
  const paragraphNumber = eId.match(/\d+/)?.[0];
  return paragraphNumber ? `para. ${paragraphNumber}` : eId;
}

/**
 * Best-effort, UK-only: if the cited authority resolved to a real judgment on The National
 * Archives, search its actual text for the quoted passage and return a real pinpoint (e.g.
 * "para. 4") — never a guess. Returns null on any miss (PH — extractCaseUri only recognizes TNA
 * URLs — unresolved, legislation/SI/EU refs, or the quote just isn't found verbatim), so the
 * lawyer can still enter one by hand via the form's own pinpoint field.
 */
export async function detectPinpoint(resolvedLawId: string | null, quotedText: string | undefined): Promise<string | null> {
  const quote = quotedText?.trim();
  if (!resolvedLawId || !quote) return null;

  const law = await LawRepo.findById(resolvedLawId);
  if (!law) return null;

  const caseUri = extractCaseUri(law.jurisUrl);
  if (!caseUri) return null;

  try {
    const result = await grepJudgment(caseUri, quote, 1);
    const hit = result.hits[0];
    return hit ? formatPinpointFromEid(hit.eId) : null;
  } catch (err) {
    logger.warn("Citation pinpoint detection failed", { err, resolvedLawId });
    return null;
  }
}
