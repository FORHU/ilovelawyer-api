import DamageClaimRepo, { DamageClaimInput } from "../repositories/damage-claim.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";
import { computeDamagesSummary, hasBasisInputs, parseDamageBasis } from "../utils/damages-compute";

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
