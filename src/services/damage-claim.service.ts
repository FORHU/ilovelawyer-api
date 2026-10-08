import DamageClaimRepo, { DamageClaimInput } from "../repositories/damage-claim.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import { damageCloseReason } from "../utils/procedure-link";
import { computeDamagesSummary } from "../utils/damages-compute";
import { damageHeadKey } from "../utils/damages-extract-parse";
import type { TenantCode } from "../types/tenant-code";

/** The case's Damages & Remedies list as chat-wonder's `case_damages` field (see the_server.py's
 * _build_case_damages_injection). Keeps the shape that function reads — `label`, `category`,
 * `amount`, `status` per head and the totals — with no range or pending evidence any more, so
 * low/high equal the total and `provisional` is false. */
export interface CaseDamagesChatContext {
  currency: string;
  total: number;
  low: number;
  high: number;
  asOf: string | null;
  provisional: boolean;
  pendingEvidence: string[];
  heads: { category: string; label: string; amount: number | null; status: string; basis: string | null; pendingEvidence: string | null }[];
}

// Optional free text: an empty string from a cleared input is stored as null.
function blankToNull<T extends Partial<DamageClaimInput>>(data: T): T {
  return typeof data.description === "string" && !data.description.trim() ? { ...data, description: null } : data;
}

export default class DamageClaimSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return DamageClaimRepo.list(caseId);
  }

  static async create(caseId: string, userId: string, input: DamageClaimInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DamageClaimRepo.create(caseId, blankToNull(input));
    await CaseGraphSvc.ensureNode(caseId, "DAMAGE_CLAIM", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.create", payload: { id: row.id, kind: row.kind } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, input: Partial<DamageClaimInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await DamageClaimRepo.findById(id, caseId);
    if (!existing) throw new HttpError("Damage claim not found", 404);
    // A lawyer's new amount is theirs: it no longer carries the AI's basis or working.
    const amountChanged = input.amount !== undefined && input.amount !== existing.amount;
    const row = await DamageClaimRepo.update(id, caseId, {
      ...blankToNull(input),
      ...(amountChanged ? { amountBasis: null, amountNote: null } : {}),
    });
    if (!row) throw new HttpError("Damage claim not found", 404);
    // A renamed AI entry would otherwise come back under its old name the next time the documents
    // are read.
    const oldKey = damageHeadKey(existing.kind, existing.title);
    if (existing.source === "AI" && damageHeadKey(row.kind, row.title) !== oldKey) await DamageClaimRepo.dismiss(caseId, oldKey);
    await CaseGraphSvc.markStale(caseId, "DAMAGE_CLAIM", id, "Damage claim updated");
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.update", payload: { id } });
    if (row.done && !existing.done) {
      await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.awarded", payload: { id, kind: row.kind } });
    }
    const closeReason = damageCloseReason(existing, row);
    if (closeReason) await ProceduralDeadlineRepo.closeLinked(caseId, "DAMAGE", id, closeReason);
    // The entry's to-dos carry its due date, so a new date moves them too.
    if (input.dueDate !== undefined && existing.dueDate?.getTime() !== row.dueDate?.getTime()) {
      await ProceduralDeadlineRepo.setLinkedDueDate(caseId, "DAMAGE", id, row.dueDate);
    }
    return row;
  }

  /** Accepts an AI proposal: it counts in the total from now on. */
  static async accept(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DamageClaimRepo.update(id, caseId, { accepted: true });
    if (!row) throw new HttpError("Damage claim not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "damage.accept", payload: { id } });
    return row;
  }

  /** Deleting an AI entry also dismisses it: re-reading the documents never proposes it again. */
  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await DamageClaimRepo.findById(id, caseId);
    if (!existing) throw new HttpError("Damage claim not found", 404);
    if (existing.source === "AI") await DamageClaimRepo.dismiss(caseId, damageHeadKey(existing.kind, existing.title));
    const deleted = await DamageClaimRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Damage claim not found", 404);
  }

  /** The case's accepted entries for a case-linked chat turn, or undefined when there are none. No
   * access check — the caller (ChatSvc) has already resolved the case for this turn. */
  static async chatContext(caseId: string, tenantCode?: TenantCode | null): Promise<CaseDamagesChatContext | undefined> {
    const rows = (await DamageClaimRepo.list(caseId)).filter((r) => r.accepted);
    if (rows.length === 0) return undefined;
    const summary = computeDamagesSummary(rows, tenantCode);
    return {
      currency: summary.currency,
      total: summary.total,
      low: summary.total,
      high: summary.total,
      asOf: null,
      provisional: false,
      pendingEvidence: [],
      heads: rows.map((r) => ({
        category: r.kind === "REMEDY" ? "Remedy" : "Damages",
        label: r.title,
        amount: r.amount,
        status: r.done ? "awarded or received" : "not yet awarded",
        basis: r.dueDate ? `due ${r.dueDate.toISOString().slice(0, 10)}` : null,
        pendingEvidence: null,
      })),
    };
  }
}
