import CaseClaimRepo, { CaseClaimInput } from "../repositories/case-claim.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";

export default class CaseClaimSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseClaimRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: CaseClaimInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseClaimRepo.create(caseId, data);
    await CaseGraphSvc.ensureNode(caseId, "CLAIM", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "claim.create", payload: { id: row.id } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<CaseClaimInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseClaimRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Claim not found", 404);
    await CaseGraphSvc.markStale(caseId, "CLAIM", id, "Claim updated");
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "claim.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseClaimRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Claim not found", 404);
  }
}
