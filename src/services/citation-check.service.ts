import CaseAccess from "../utils/case-access";
import CitationCheckRepo from "../repositories/citation-check.repository";
import { evaluateCitation } from "../utils/citation-validity";
import LegalRagRepo from "../repositories/legal-rag.repository";
import OrganizationRepo from "../repositories/organization.repository";

export default class CitationCheckSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CitationCheckRepo.list(caseId);
  }

  static async check(
    caseId: string,
    userId: string,
    body: { quotedText: string; citedReference?: string; sourceUrl?: string; officialText?: string; legalRagId?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);

    let officialText = body.officialText ?? null;
    if (!officialText && body.legalRagId) {
      const id = BigInt(body.legalRagId);
      const doc = await LegalRagRepo.findById(id).catch(() => null);
      officialText = doc?.full_text ?? doc?.formatted_markdown ?? null;
    }

    const result = evaluateCitation({
      quotedText: body.quotedText,
      officialText,
      citedReference: body.citedReference,
    });

    const row = await CitationCheckRepo.create(caseId, {
      quotedText: body.quotedText,
      citedReference: body.citedReference ?? null,
      sourceUrl: body.sourceUrl ?? null,
      officialText,
      status: result.status,
      notes: result.notes,
    });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "citation.check", payload: { id: row.id, status: row.status } });
    return row;
  }
}
