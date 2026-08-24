import WitnessRepo, { WitnessInput } from "../repositories/witness.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";

export default class WitnessSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return WitnessRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, data: WitnessInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await WitnessRepo.create(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "witness.create", payload: { id: row.id } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<WitnessInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await WitnessRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Witness not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "witness.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await WitnessRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Witness not found", 404);
  }
}
