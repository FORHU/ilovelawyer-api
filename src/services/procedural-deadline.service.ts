import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
import CaseAccess from "../utils/case-access";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import { getDeadlineEngine } from "../legal/deadline-engine.registry";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import { TenantCode } from "../types/tenant-code";
import CaseGraphSvc from "./case-graph.service";
import CaseFindingRepo from "../repositories/case-finding.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import WitnessRepo from "../repositories/witness.repository";
import { findingFixedTag, type ProcedureSourceKind } from "../utils/procedure-link";
import CaseFindingSvc from "./case-finding.service";
import DamageClaimSvc from "./damage-claim.service";
import WitnessSvc from "./witness.service";

// The UK deadline engine only implements England & Wales CPR rules and bank-holiday calendar
// today — applying them to a Scotland or Northern Ireland case would silently compute the wrong
// due date (different court rules, different holiday sets), so those two are blocked here
// rather than producing a confidently-wrong answer. England and Wales and an unset Jurisdiction
// (historical default, pre-dating Case.ukJurisdiction) both pass through unchanged.
const UK_JURISDICTIONS_WITHOUT_DEADLINE_RULES = new Set(["Scotland", "Northern Ireland"]);

export default class ProceduralDeadlineSvc {
  static rules(tenantCode: TenantCode) {
    return getDeadlineEngine(tenantCode).listRules();
  }

  private static async assertDeadlineEngineSupportsCase(caseId: string, tenantCode: TenantCode): Promise<void> {
    if (tenantCode !== "UK") return;
    const ukJurisdiction = await CaseAccess.resolveUkJurisdiction(caseId);
    if (ukJurisdiction && UK_JURISDICTIONS_WITHOUT_DEADLINE_RULES.has(ukJurisdiction)) {
      throw new HttpError(
        `Procedural deadline calculation isn't available for ${ukJurisdiction} yet — today it only implements England & Wales court rules and bank holidays. LEGAL_REVIEW_REQUIRED: track this deadline manually until ${ukJurisdiction} rules are added.`,
        501,
      );
    }
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
    await ProceduralDeadlineSvc.assertDeadlineEngineSupportsCase(caseId, tenantCode);
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
    await ManualEditLog.record(caseId, userId, { pane: "procedure", kind: "deadline", itemId: row.id, action: "added", label: row.label });
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
    await ProceduralDeadlineSvc.assertDeadlineEngineSupportsCase(caseId, tenantCode);
    const computation = getDeadlineEngine(tenantCode).calculate(deadline.ruleCode, triggerDate);

    const row = await ProceduralDeadlineRepo.updateComputed(deadlineId, {
      triggerDate: computation.triggerDate,
      computedDueDate: computation.computedDueDate,
      calculationNotes: computation.calculationNotes,
    });
    await CaseGraphSvc.clearStale("PROCEDURAL_DEADLINE", deadlineId);
    // Confirmations vouch for a specific date. If the date moved, they no longer apply — a
    // dual-confirmed deadline must not stay "confirmed" against a date nobody confirmed.
    const dueDateChanged = row.computedDueDate.getTime() !== deadline.computedDueDate.getTime();
    if (dueDateChanged) await ProceduralDeadlineRepo.clearConfirmations(deadlineId);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "deadline.recompute",
      payload: {
        id: deadlineId,
        due: row.computedDueDate,
        previousDue: deadline.computedDueDate,
        confirmationsCleared: dueDateChanged,
      },
    });
    await ManualEditLog.record(caseId, userId, {
      pane: "procedure",
      kind: "deadline",
      itemId: deadlineId,
      action: "recomputed",
      label: deadline.label,
      changes: fieldChanges(deadline, { computedDueDate: row.computedDueDate }, { computedDueDate: "value" }),
    });
    return row;
  }

  /**
   * The one-click "recompute all" behind the Case Strategy panel's stale-deadline banner: runs the
   * same deterministic recompute() on every deadline the case graph has flagged stale (its source
   * timeline event moved). Still an explicit lawyer action, never automatic — a due date is a legal
   * fact, so it only changes when someone asks. One deadline failing (e.g. a Scotland case with no
   * rules) is reported and doesn't stop the rest. A changed date clears that deadline's
   * confirmations (see recompute), so the panel re-prompts for them.
   */
  static async recomputeStale(caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const stale = (await CaseGraphSvc.listStaleForCase(caseId)).filter((n) => n.nodeType === "PROCEDURAL_DEADLINE");
    const recomputed: { id: string; computedDueDate: Date }[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const node of stale) {
      try {
        const row = await ProceduralDeadlineSvc.recompute(caseId, node.refId, userId);
        recomputed.push({ id: row.id, computedDueDate: row.computedDueDate });
      } catch (err) {
        failed.push({ id: node.refId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { recomputed, failed };
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
    await ManualEditLog.record(caseId, userId, {
      pane: "procedure",
      kind: "deadline",
      itemId: deadlineId,
      action: confirmed ? "confirmed" : "unconfirmed",
      label: deadline.label,
    });
    return {
      confirmation,
      dualConfirmed: confirms.length >= requiredConfirmations,
      requiredConfirmations,
      confirmCount: confirms.length,
      deadline: refreshed,
    };
  }

  static async createItem(
    caseId: string,
    userId: string,
    body: {
      kind: string;
      label: string;
      notes?: string;
      sourceLabel?: string | null;
      sourceKind?: ProcedureSourceKind;
      sourceId?: string;
      sourceKey?: string;
    },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const sourceKey = body.sourceKey ?? null;
    let dueDate: Date | null = null;
    if (body.sourceKind && body.sourceId) {
      ({ dueDate } = await ProceduralDeadlineSvc.loadSource(caseId, body.sourceKind, body.sourceId, sourceKey));
      // Sending the same item twice returns the to-do it already has, rather than a duplicate.
      const existing = await ProceduralDeadlineRepo.findOpenLinked(caseId, body.sourceKind, body.sourceId, sourceKey);
      if (existing) return existing;
    }
    const item = await ProceduralDeadlineRepo.createProcedureItem(caseId, {
      ...body,
      sourceLabel: body.sourceLabel || null,
      sourceKind: body.sourceKind ?? null,
      sourceId: body.sourceId ?? null,
      sourceKey,
      dueDate,
    });
    await ManualEditLog.record(caseId, userId, { pane: "procedure", kind: "todo", itemId: item.id, action: "added", label: item.label });
    return item;
  }

  /** A to-do may only link to an item on its own case (and, for a witness need, a need that
   * witness actually has). Returns the due date the to-do takes from it — a Damages & Remedies
   * entry's own; the other sources have none. */
  private static async loadSource(
    caseId: string,
    kind: ProcedureSourceKind,
    id: string,
    key: string | null,
  ): Promise<{ dueDate: Date | null }> {
    if (kind === "FINDING") {
      if (await CaseFindingRepo.find(id, caseId)) return { dueDate: null };
    } else if (kind === "DAMAGE") {
      const entry = await DamageClaimRepo.findById(id, caseId);
      if (entry) return { dueDate: entry.dueDate };
    } else if (kind === "WITNESS_NEED") {
      const witness = (await WitnessRepo.list(caseId)).find((w) => w.id === id);
      const needs = (witness?.aiFactors as { needs?: { key: string }[] } | null)?.needs ?? [];
      if (witness && needs.some((n) => n.key === key)) return { dueDate: null };
    }
    throw new HttpError("The item this to-do was sent from isn't on this case", 404);
  }

  static async updateItem(caseId: string, id: string, userId: string, body: { done?: boolean; notes?: string; label?: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await ProceduralDeadlineRepo.findProcedureItem(id, caseId);
    const row = await ProceduralDeadlineRepo.updateProcedureItem(id, caseId, body);
    if (!row) throw new HttpError("Procedure item not found", 404);
    if (body.done !== undefined && before && before.done !== row.done) {
      await ManualEditLog.record(caseId, userId, { pane: "procedure", kind: "todo", itemId: id, action: row.done ? "ticked" : "unticked", label: row.label });
    }
    await ManualEditLog.record(caseId, userId, {
      pane: "procedure",
      kind: "todo",
      itemId: id,
      action: "edited",
      label: row.label,
      changes: fieldChanges(before, body, { label: "value", notes: "text" }),
    });
    if (body.done === true && row.sourceKind && row.sourceId) {
      await ProceduralDeadlineSvc.settleSource(caseId, userId, row.sourceKind as ProcedureSourceKind, row.sourceId, row.sourceKey);
    }
    return row;
  }

  /**
   * Ticking a linked to-do settles the item it came from, the other half of the item ticking its
   * to-do: a finding moves to its category's fixed tag (Answered, Closed, Ready, Resolved), a
   * Damages & Remedies entry is marked awarded or received, and a witness's statement item marks
   * the statement received. Goes through each item's own service, so the change is audited and the
   * item's other open to-dos tick with it. Left alone: a strength (no fixed state) and any other
   * witness item, since ticking one needs a proof document a to-do doesn't carry. Reopening a
   * to-do never unsettles its item.
   */
  private static async settleSource(caseId: string, userId: string, kind: ProcedureSourceKind, id: string, key: string | null) {
    try {
      if (kind === "FINDING") {
        const finding = await CaseFindingRepo.find(id, caseId);
        const fixed = finding ? findingFixedTag(finding.category) : null;
        if (finding && fixed && finding.tag !== fixed) await CaseFindingSvc.update(caseId, id, userId, { tag: fixed });
      } else if (kind === "DAMAGE") {
        const entry = await DamageClaimRepo.findById(id, caseId);
        if (entry && !entry.done) await DamageClaimSvc.update(caseId, id, userId, { done: true });
      } else if (key === "STATEMENT") {
        const witness = (await WitnessRepo.list(caseId)).find((w) => w.id === id);
        if (witness && !witness.statementReceived) await WitnessSvc.update(caseId, id, userId, { statementReceived: true });
      }
    } catch (err) {
      // The item was deleted after the to-do was sent: the tick still stands.
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    }
  }
}
