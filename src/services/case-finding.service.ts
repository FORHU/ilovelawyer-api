import { FindingCategory } from "@prisma/client";
import CaseFindingRepo, { FindingInput } from "../repositories/case-finding.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";

export default class CaseFindingSvc {
  static async list(caseId: string, userId: string, category?: FindingCategory) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseFindingRepo.list(caseId, category);
  }

  static async create(caseId: string, userId: string, data: FindingInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseFindingRepo.create(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.create", payload: { id: row.id, category: row.category } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<FindingInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseFindingRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Finding not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseFindingRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Finding not found", 404);
  }
}
