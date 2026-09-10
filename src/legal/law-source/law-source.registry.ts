import { TenantCode } from "../../types/tenant-code";
import HttpError from "../../utils/http-error";
import { LawSourceProvider } from "./law-source-provider";
import { PhLawSourceProvider } from "./ph/ph-law-source.provider";
import { UkLawSourceProvider } from "./uk/uk-law-source.provider";

const phProvider = new PhLawSourceProvider();
const ukProvider = new UkLawSourceProvider();

/** Selects the Library's live legal-source provider strictly by tenantCode — never by client
 * input, never with a cross-jurisdiction fallback. An unmapped tenantCode is a hard 501, not a
 * silent PH default. Same shape as legal-knowledge.registry.ts / prompt-registry.ts. */
export function getLawSourceProvider(tenantCode: TenantCode): LawSourceProvider {
  switch (tenantCode) {
    case "PH":
      return phProvider;
    case "UK":
      return ukProvider;
    default:
      throw new HttpError(
        `Legal research is not available for this jurisdiction (${tenantCode}) — coming soon`,
        501,
      );
  }
}
