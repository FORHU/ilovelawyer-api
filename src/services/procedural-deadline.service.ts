import CaseAccess from "../utils/case-access";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { getDeadlineEngine } from "../legal/deadline-engine.registry";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import { Jurisdiction } from "../types/jurisdiction";

export default class ProceduralDeadlineSvc {
  static rules(jurisdiction: Jurisdiction) {
    return getDeadlineEngine(jurisdiction).listRules();
  }

  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const [deadlines, items] = await Promise.all([
      ProceduralDeadlineRepo.list(caseId),
      ProceduralDeadlineRepo.listProcedureItems(caseId),
    ]);
    return { deadlines, items };
  }

  static async create(
    caseId: string,
    userId: string,
    body: { ruleCode: string; triggerDate: string; serviceMethod?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const triggerDate = new Date(body.triggerDate);
    if (Number.isNaN(triggerDate.getTime())) throw new HttpError("Invalid triggerDate", 400);

    const jurisdiction = await CaseAccess.resolveJurisdiction(caseId);
    const computation = getDeadlineEngine(jurisdiction).calculate(body.ruleCode, triggerDate);

    const row = await ProceduralDeadlineRepo.create(caseId, {
      label: computation.rule.label,
      ruleCode: computation.rule.code,
      triggerDate: computation.triggerDate,
      computedDueDate: computation.computedDueDate,
      ruleSource: computation.rule.ruleSource,
      serviceMethod: body.serviceMethod ?? null,
      calculationNotes: computation.calculationNotes,
    });
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.create",
      payload: { id: row.id, due: row.computedDueDate },
    });
    return row;
  }

  static async confirm(caseId: string, deadlineId: string, userId: string, confirmed: boolean, note?: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deadline = await ProceduralDeadlineRepo.findById(deadlineId, caseId);
    if (!deadline) throw new HttpError("Deadline not found", 404);
    const confirmation = await ProceduralDeadlineRepo.confirm(deadlineId, userId, confirmed, note);
    const refreshed = await ProceduralDeadlineRepo.findById(deadlineId, caseId);
    const confirms = (refreshed?.confirmations ?? []).filter((c) => c.confirmed);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.confirm",
      payload: { deadlineId, confirmed, confirmCount: confirms.length },
    });
    return {
      confirmation,
      dualConfirmed: confirms.length >= 2,
      confirmCount: confirms.length,
      deadline: refreshed,
    };
  }

  static async createItem(caseId: string, userId: string, body: { kind: string; label: string; notes?: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    return ProceduralDeadlineRepo.createProcedureItem(caseId, body);
  }

  static async updateItem(caseId: string, id: string, userId: string, body: { done?: boolean; notes?: string; label?: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await ProceduralDeadlineRepo.updateProcedureItem(id, caseId, body);
    if (!row) throw new HttpError("Procedure item not found", 404);
    return row;
  }
}
