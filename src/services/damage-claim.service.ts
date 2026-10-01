import DamageClaimRepo, { DamageClaimInput } from "../repositories/damage-claim.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { damageCloseReason } from "../utils/procedure-link";
import { computeDamagesSummary, describeDamageBasis, hasBasisInputs, parseDamageBasis } from "../utils/damages-compute";
import { parseDamageProposal } from "../utils/damages-proposal";
import type { TenantCode } from "../types/tenant-code";

/** The case's damages model as chat-wonder's `case_damages` field (see the_server.py's
 * _build_case_damages_injection). */
export interface CaseDamagesChatContext {
  currency: string;
  total: number;
  low: number;
  high: number;
  asOf: string | null;
  provisional: boolean;
  pendingEvidence: string[];
  heads: { category: string; label: string | null; amount: number | null; status: string; basis: string | null; pendingEvidence: string | null }[];
}

type DamageRow = NonNullable<Awaited<ReturnType<typeof DamageClaimRepo.findById>>>;

// Optional free-text fields: an empty string from a cleared input is stored as null.
function blankToNull<T extends Partial<DamageClaimInput>>(data: T): T {
  const out = { ...data };
  for (const key of ["label", "pendingEvidence", "legalBasis"] as const) {
    if (typeof out[key] === "string" && !(out[key] as string).trim()) out[key] = null;
  }
  return out;
}

/** Refuses a head the model can't stand behind: a range the wrong way round, or CERTIFIED with
 * nothing to certify. Checked against the head as it will be after the write. */
function assertConsistent(head: Pick<DamageRow, "amount" | "basis" | "amountLow" | "amountHigh" | "status">) {
  if (head.amountLow != null && head.amountHigh != null && head.amountLow > head.amountHigh) {
    throw new HttpError("The low end of the range can't be above the high end", 400);
  }
  if (head.status === "CERTIFIED" && !hasBasisInputs(head)) {
    throw new HttpError("Add an amount or the rate and period before marking this head certified", 400);
  }
}

export default class DamageClaimSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return DamageClaimRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, input: DamageClaimInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const data = blankToNull(input);
    assertConsistent({
      amount: data.amount ?? null,
      basis: data.basis ?? null,
      amountLow: data.amountLow ?? null,
      amountHigh: data.amountHigh ?? null,
      status: data.status ?? "PROVISIONAL",
    });
    const row = await DamageClaimRepo.create(caseId, data);
    await CaseGraphSvc.ensureNode(caseId, "DAMAGE_CLAIM", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.create", payload: { id: row.id, category: row.category } });
    await DamageClaimSvc.recompute(caseId);
    return (await DamageClaimRepo.findById(row.id, caseId)) ?? row;
  }

  static async update(caseId: string, id: string, userId: string, input: Partial<DamageClaimInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await DamageClaimRepo.findById(id, caseId);
    if (!existing) throw new HttpError("Damage claim not found", 404);
    const data = blankToNull(input);
    assertConsistent({
      amount: data.amount !== undefined ? data.amount : existing.amount,
      basis: data.basis !== undefined ? data.basis : existing.basis,
      amountLow: data.amountLow !== undefined ? data.amountLow : existing.amountLow,
      amountHigh: data.amountHigh !== undefined ? data.amountHigh : existing.amountHigh,
      status: data.status ?? existing.status,
    });

    const row = await DamageClaimRepo.update(id, caseId, data);
    if (!row) throw new HttpError("Damage claim not found", 404);
    await CaseGraphSvc.markStale(caseId, "DAMAGE_CLAIM", id, "Damage claim updated");
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.update", payload: { id } });
    if (row.status === "CERTIFIED" && existing.status !== "CERTIFIED") {
      await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.certify", payload: { id, category: row.category } });
    }
    const closeReason = damageCloseReason(existing, row);
    if (closeReason) await ProceduralDeadlineRepo.closeLinked(caseId, "DAMAGE", id, closeReason);
    await DamageClaimSvc.recompute(caseId, id);
    return (await DamageClaimRepo.findById(id, caseId)) ?? row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await DamageClaimRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Damage claim not found", 404);
    // A derived head (attorney's fees) may have been computed from the one just removed.
    await DamageClaimSvc.recompute(caseId);
  }

  /**
   * Applies a suggested update (aiProposedBasis): the proposed figures replace the head's, and when
   * the document was the evidence the head was waiting on, the head is certified and stops waiting.
   * Audited as damage.proposal.apply (plus damage.certify when it certifies).
   */
  static async applyProposal(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await DamageClaimRepo.findById(id, caseId);
    if (!existing) throw new HttpError("Damage claim not found", 404);
    const proposal = parseDamageProposal(existing.aiProposedBasis);
    if (!proposal) throw new HttpError("This head has no suggested update", 409);

    const certify = proposal.satisfiesPending === true && existing.status !== "CERTIFIED";
    const data = {
      basis: proposal.basis,
      ...(proposal.basis.kind === "FIXED" ? { amount: proposal.amount } : {}),
      ...(certify ? { status: "CERTIFIED" as const, pendingEvidence: null } : {}),
    };
    assertConsistent({
      amount: proposal.basis.kind === "FIXED" ? proposal.amount : existing.amount,
      basis: proposal.basis,
      amountLow: existing.amountLow,
      amountHigh: existing.amountHigh,
      status: certify ? "CERTIFIED" : existing.status,
    });
    await DamageClaimRepo.update(id, caseId, data);
    await DamageClaimRepo.setProposal(id, caseId, null);
    await CaseGraphSvc.markStale(caseId, "DAMAGE_CLAIM", id, "Damage claim updated from new evidence");
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "damage.proposal.apply",
      payload: { id, documentId: proposal.sourceDocumentId },
    });
    if (certify) {
      await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.certify", payload: { id, category: existing.category } });
      await ProceduralDeadlineRepo.closeLinked(caseId, "DAMAGE", id, "DAMAGE_CERTIFIED");
    }
    await DamageClaimSvc.recompute(caseId, id);
    return DamageClaimRepo.findById(id, caseId);
  }

  static async dismissProposal(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await DamageClaimRepo.findById(id, caseId);
    if (!existing) throw new HttpError("Damage claim not found", 404);
    await DamageClaimRepo.setProposal(id, caseId, null);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.proposal.dismiss", payload: { id } });
    return DamageClaimRepo.findById(id, caseId);
  }

  /** The damages model for a case-linked chat turn, or undefined when the case has no heads. No
   * access check — the caller (ChatSvc) has already resolved the case for this turn. */
  static async chatContext(caseId: string, tenantCode?: TenantCode | null): Promise<CaseDamagesChatContext | undefined> {
    const rows = await DamageClaimRepo.list(caseId);
    if (rows.length === 0) return undefined;
    const summary = computeDamagesSummary(rows, tenantCode);
    const byId = new Map(summary.heads.map((h) => [h.id, h]));
    return {
      currency: summary.currency,
      total: summary.total,
      low: summary.low,
      high: summary.high,
      asOf: summary.asOf,
      provisional: summary.provisional,
      pendingEvidence: summary.pendingEvidence,
      heads: rows.map((r) => ({
        category: r.category,
        label: r.label,
        amount: byId.get(r.id)?.amount ?? r.amount,
        status: byId.get(r.id)?.effectiveStatus ?? r.status,
        basis: describeDamageBasis(r.basis),
        pendingEvidence: r.pendingEvidence,
      })),
    };
  }

  /**
   * Re-runs the case's damages arithmetic and stores each computed amount, so `amount` on a
   * RATE_X_PERIOD or PERCENT_OF head is never stale — editing Actual changes Attorney's fees in the
   * same request. Derived heads whose amount moved are marked stale in the case graph too (the head
   * the lawyer edited already was, by update()).
   */
  static async recompute(caseId: string, editedId?: string) {
    const rows = await DamageClaimRepo.list(caseId);
    const summary = computeDamagesSummary(rows);
    const changes = summary.heads
      .map((head) => ({ head, row: rows.find((r) => r.id === head.id)! }))
      .filter(({ head, row }) => parseDamageBasis(row.basis).kind !== "FIXED" && head.amount !== row.amount)
      .map(({ head }) => ({ id: head.id, amount: head.amount, derived: head.derived }));
    await DamageClaimRepo.setAmounts(changes);
    for (const change of changes) {
      if (change.derived && change.id !== editedId) {
        await CaseGraphSvc.markStale(caseId, "DAMAGE_CLAIM", change.id, "Recomputed from other damage heads");
      }
    }
  }
}
