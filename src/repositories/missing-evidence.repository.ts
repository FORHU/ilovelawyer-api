import { MissingEvidenceSeverity, MissingEvidenceStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { AI_MISSING_EVIDENCE_NOTE } from "../constants/missing-evidence.constants";

/** One AI-generated gap as replaceAiItems stores it. */
export interface AiMissingEvidenceRow {
  label: string;
  detail: string | null;
  suggestedSource: string | null;
  claimId: string | null;
  severity: MissingEvidenceSeverity;
}

export default class MissingEvidenceRepo {
  /**
   * Open gaps first, then the most severe, so the panel leads with what still needs work. Each
   * row carries its claim's title as `claimLabel`: claimId is a plain id, and the app has no
   * claims endpoint of its own, so resolving it here is the only way the pane can name the claim
   * a gap belongs to. Null when the gap is case-wide or the claim has since been deleted.
   */
  static async list(caseId: string) {
    const [rows, claims] = await Promise.all([
      prisma.caseMissingEvidence.findMany({ where: { caseId } }),
      prisma.caseClaim.findMany({ where: { caseId }, select: { id: true, title: true } }),
    ]);
    const claimTitle = new Map(claims.map((claim) => [claim.id, claim.title]));
    const byStatus = { OPEN: 0, RESOLVED: 1, DISMISSED: 2 } as const;
    const bySeverity = { CRITICAL: 0, MODERATE: 1, MINOR: 2 } as const;
    return rows
      .map((row) => ({ ...row, claimLabel: (row.claimId && claimTitle.get(row.claimId)) || null }))
      .sort(
        (a, b) =>
          byStatus[a.status] - byStatus[b.status] ||
          bySeverity[a.severity] - bySeverity[b.severity] ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
  }

  /** The lawyer's triage. Mirrors EvidenceRepo.updateContradictionStatus: reopening clears the
   * resolution, so a row never shows a stale note beside an OPEN status. */
  static async updateStatus(
    id: string,
    caseId: string,
    data: { status: MissingEvidenceStatus; resolutionNote: string | null; resolvedById: string | null },
  ) {
    const existing = await prisma.caseMissingEvidence.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    const open = data.status === "OPEN";
    return prisma.caseMissingEvidence.update({
      where: { id },
      data: {
        status: data.status,
        resolutionNote: open ? null : data.resolutionNote,
        resolvedAt: open ? null : new Date(),
        resolvedById: open ? null : data.resolvedById,
      },
    });
  }

  /**
   * Replaces every AI-authored row with a fresh batch — mirrors CaseFindingRepo.replaceAiFindings.
   * Manually-created rows are untouched, and so are AI rows a lawyer has edited (lawyerEditedAt);
   * an incoming row repeating one of those is dropped rather than duplicated. A row a lawyer has
   * already triaged is replaced like any other: carrying triage across regenerations needs the
   * gap to be identified across runs, which is the change tracked in issue #315.
   */
  static async replaceAiItems(caseId: string, items: AiMissingEvidenceRow[]) {
    await prisma.$transaction(async (tx) => {
      const kept = await tx.caseMissingEvidence.findMany({
        where: { caseId, notes: AI_MISSING_EVIDENCE_NOTE, lawyerEditedAt: { not: null } },
        select: { label: true },
      });
      const keptLabels = new Set(kept.map((row) => row.label.trim().toLowerCase()));
      await tx.caseMissingEvidence.deleteMany({
        where: { caseId, notes: AI_MISSING_EVIDENCE_NOTE, lawyerEditedAt: null },
      });
      const fresh = items.filter((item) => !keptLabels.has(item.label.trim().toLowerCase()));
      if (fresh.length === 0) return;
      await tx.caseMissingEvidence.createMany({
        data: fresh.map((item) => ({ ...item, caseId, notes: AI_MISSING_EVIDENCE_NOTE })),
      });
    });
    return this.list(caseId);
  }
}
