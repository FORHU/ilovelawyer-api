import { RiskInput } from "../repositories/case-risk.repository";
import CaseRiskRepo from "../repositories/case-risk.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";

export default class CaseRiskSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseRiskRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: RiskInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseRiskRepo.create(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "risk.create", payload: { id: row.id, severity: row.severity } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<RiskInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseRiskRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Risk not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "risk.update", payload: { id, status: row.status } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseRiskRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Risk not found", 404);
  }
}
