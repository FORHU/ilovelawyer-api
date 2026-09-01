import CaseAccess from "../utils/case-access";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import { getDeadlineEngine } from "../legal/deadline-engine.registry";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import { TenantCode } from "../types/tenant-code";
import CaseGraphSvc from "./case-graph.service";

export default class ProceduralDeadlineSvc {
  static rules(tenantCode: TenantCode) {
    return getDeadlineEngine(tenantCode).listRules();
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
    body: { ruleCode: string; triggerDate: string; serviceMethod?: string; sourceTimelineEventId?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const triggerDate = new Date(body.triggerDate);
    if (Number.isNaN(triggerDate.getTime())) throw new HttpError("Invalid triggerDate", 400);

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const computation = getDeadlineEngine(tenantCode).calculate(body.ruleCode, triggerDate);

    const row = await ProceduralDeadlineRepo.create(caseId, {
      label: computation.rule.label,
      ruleCode: computation.rule.code,
      triggerDate: computation.triggerDate,
      computedDueDate: computation.computedDueDate,
      ruleSource: computation.rule.ruleSource,
      serviceMethod: body.serviceMethod ?? null,
      calculationNotes: computation.calculationNotes,
    });

    if (body.sourceTimelineEventId) {
      const sourceEvent = await CaseTimelineRepo.findById(body.sourceTimelineEventId, caseId);
      if (!sourceEvent) throw new HttpError("sourceTimelineEventId not found on this case", 400);
      await CaseGraphSvc.linkNodes(
        caseId,
        "TIMELINE_EVENT",
        sourceEvent.id,
        "PROCEDURAL_DEADLINE",
        row.id,
        "TRIGGERS_DEADLINE",
      );
    }

    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.create",
      payload: { id: row.id, due: row.computedDueDate },
    });
    return row;
  }

  /**
   * Re-runs the same deterministic calculation as create(), using the linked source timeline
   * event's current date if this deadline was created with one (falling back to its own stored
   * triggerDate otherwise), then clears the graph staleness flag. Never runs automatically —
   * only ever called explicitly, same as create().
   */
  static async recompute(caseId: string, deadlineId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deadline = await ProceduralDeadlineRepo.findById(deadlineId, caseId);
    if (!deadline) throw new HttpError("Deadline not found", 404);

    const source = await CaseGraphSvc.findIncomingSource("PROCEDURAL_DEADLINE", deadlineId);
    let triggerDate = deadline.triggerDate;
    if (source?.nodeType === "TIMELINE_EVENT") {
      const event = await CaseTimelineRepo.findById(source.refId, caseId);
      if (event?.occurredOn) triggerDate = event.occurredOn;
    }

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const computation = getDeadlineEngine(tenantCode).calculate(deadline.ruleCode, triggerDate);

    const row = await ProceduralDeadlineRepo.updateComputed(deadlineId, {
      triggerDate: computation.triggerDate,
      computedDueDate: computation.computedDueDate,
      calculationNotes: computation.calculationNotes,
    });
    await CaseGraphSvc.clearStale("PROCEDURAL_DEADLINE", deadlineId);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.recompute",
      payload: { id: deadlineId, due: row.computedDueDate },
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
    const requiredConfirmations = await CaseAccess.requiredConfirmations(caseId);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.confirm",
      payload: { deadlineId, confirmed, confirmCount: confirms.length },
    });
    return {
      confirmation,
      dualConfirmed: confirms.length >= requiredConfirmations,
      requiredConfirmations,
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
