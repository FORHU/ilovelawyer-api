import { Jurisdiction } from "../types/jurisdiction";
import { LegalKnowledgeProvider } from "./legal-knowledge-provider";
import { PHLegalKnowledgeProvider } from "./ph/legal-knowledge/ph-legal-knowledge.provider";
import { UKLegalKnowledgeProvider } from "./uk/legal-knowledge/uk-legal-knowledge.provider";
import HttpError from "../utils/http-error";

const phProvider = new PHLegalKnowledgeProvider();
const ukProvider = new UKLegalKnowledgeProvider();

/** Selects the legal-knowledge provider strictly by jurisdiction — never by client input, never
 * with a fallback between jurisdictions. An unmapped jurisdiction is a hard error, not a silent
 * PH default. Same shape as deadline-engine.registry.ts / prompt-registry.ts. */
export function getLegalKnowledgeProvider(jurisdiction: Jurisdiction): LegalKnowledgeProvider {
  switch (jurisdiction) {
    case "PH":
      return phProvider;
    case "UK":
      return ukProvider;
    default:
      throw new HttpError(`No legal-knowledge provider configured for jurisdiction: ${jurisdiction}`, 501);
  }
}
