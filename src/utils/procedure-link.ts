import type { DamageStatus, FindingCategory, FindingTag } from "@prisma/client";

/**
 * A Case Strategy to-do sent over from another panel keeps a link to the item it was raised on
 * (ProcedureItem.sourceKind/sourceId/sourceKey). When that item reaches its fixed state the to-do
 * ticks itself, recording why — the rules for "fixed" live here, one per source.
 */
export const PROCEDURE_SOURCE_KINDS = ["FINDING", "DAMAGE", "WITNESS_NEED"] as const;
export type ProcedureSourceKind = (typeof PROCEDURE_SOURCE_KINDS)[number];

/** Stored on ProcedureItem.autoClosedReason; the app translates it. */
export type ProcedureAutoCloseReason =
  | "ISSUE_RESOLVED"
  | "WEAKNESS_CLOSED"
  | "ATTACK_READY"
  | "DEFENSE_ANSWERED"
  | "DAMAGE_CERTIFIED"
  | "DAMAGE_EVIDENCE_IN"
  | "WITNESS_NEED_DONE";

// Strengths have no fixed state — a strength is never "done", so its to-dos only close by hand.
const FINDING_FIXED_TAG: Partial<Record<FindingCategory, { tag: FindingTag; reason: ProcedureAutoCloseReason }>> = {
  LEGAL_ISSUE: { tag: "RESOLVED", reason: "ISSUE_RESOLVED" },
  WEAKNESS: { tag: "CLOSED", reason: "WEAKNESS_CLOSED" },
  ATTACK_STRATEGY: { tag: "READY", reason: "ATTACK_READY" },
  DEFENSE_STRATEGY: { tag: "ANSWERED", reason: "DEFENSE_ANSWERED" },
};

/** Why a finding's tag change closes its to-dos, or null when it doesn't (no change, or not into
 * the category's fixed tag). */
export function findingCloseReason(
  category: FindingCategory,
  before: FindingTag | null,
  after: FindingTag | null | undefined,
): ProcedureAutoCloseReason | null {
  const fixed = FINDING_FIXED_TAG[category];
  if (!fixed || after === undefined || after === before) return null;
  return after === fixed.tag ? fixed.reason : null;
}

type DamageState = { status: DamageStatus; pendingEvidence: string | null };

/** A damage head's to-do asks for the evidence it is waiting on, so it closes when the head is
 * certified or stops waiting. */
export function damageCloseReason(before: DamageState, after: DamageState): ProcedureAutoCloseReason | null {
  if (after.status === "CERTIFIED" && before.status !== "CERTIFIED") return "DAMAGE_CERTIFIED";
  if (before.pendingEvidence && !after.pendingEvidence) return "DAMAGE_EVIDENCE_IN";
  return null;
}

/** Witness need keys ticked by this write — each closes the to-do raised on that need. */
export function newlyDoneNeedKeys(before: { key: string }[], after: { key: string }[]): string[] {
  const prior = new Set(before.map((d) => d.key));
  return [...new Set(after.map((d) => d.key))].filter((key) => !prior.has(key));
}

type FindingIdentity = { id: string; category: FindingCategory; label: string };

/**
 * An analysis refresh deletes every AI finding and writes a fresh batch (replaceAiFindings), so
 * the ids to-dos point at go away. A finding that comes back in the same category with the same
 * label is the same finding: map its old id to the new one. Anything unmatched keeps its old id
 * and reads as a removed source.
 */
export function matchRegeneratedFindings(stale: FindingIdentity[], created: FindingIdentity[]): Map<string, string> {
  const key = (f: FindingIdentity) => `${f.category}\u0000${f.label.trim().toLowerCase()}`;
  const available = new Map<string, string[]>();
  for (const f of created) available.set(key(f), [...(available.get(key(f)) ?? []), f.id]);
  const moved = new Map<string, string>();
  for (const f of stale) {
    const next = available.get(key(f))?.shift();
    if (next) moved.set(f.id, next);
  }
  return moved;
}
