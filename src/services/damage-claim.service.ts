import DamageClaimRepo, { DamageClaimInput } from "../repositories/damage-claim.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";

export default class DamageClaimSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return DamageClaimRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: DamageClaimInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DamageClaimRepo.create(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.create", payload: { id: row.id, category: row.category } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<DamageClaimInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DamageClaimRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Damage claim not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await DamageClaimRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Damage claim not found", 404);
  }
}
