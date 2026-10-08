import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
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
    await ManualEditLog.record(caseId, userId, { pane: "command", kind: "risk", itemId: row.id, action: "added", label: row.title });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<RiskInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CaseRiskRepo.find(id, caseId);
    const row = await CaseRiskRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Risk not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "risk.update", payload: { id, status: row.status } });
    await ManualEditLog.record(caseId, userId, {
      pane: "command",
      kind: "risk",
      itemId: id,
      action: "edited",
      label: row.title,
      changes: fieldChanges(before, data, { title: "value", description: "text", severity: "value", status: "value", confidence: "value" }),
    });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CaseRiskRepo.find(id, caseId);
    const deleted = await CaseRiskRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Risk not found", 404);
    if (before) await ManualEditLog.record(caseId, userId, { pane: "command", kind: "risk", itemId: id, action: "removed", label: before.title });
  }
}
