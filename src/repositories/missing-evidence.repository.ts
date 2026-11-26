import { MissingEvidenceSeverity, MissingEvidenceStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { AI_MISSING_EVIDENCE_NOTE, CLIENT_INTAKE_EVIDENCE_NOTE } from "../constants/missing-evidence.constants";

/** One proof suggested to the client from their story, as createClientIntakeOnce stores it. */
export interface ClientIntakeEvidenceRow {
  label: string;
  detail: string | null;
  /** How it's best added: "photos", "files", "email" or "memo". */
  suggestedSource: string;
}

/** A stable 32-bit key for an advisory lock on one case's suggestions (as intake-chat.repository's). */
function lockKeyFor(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return hash;
}

/** One AI-generated gap as replaceAiItems stores it. */
export interface AiMissingEvidenceRow {
  label: string;
  detail: string | null;
  suggestedSource: string | null;
  claimId: string | null;
  severity: MissingEvidenceSeverity;
}

export default class MissingEvidenceRepo {
  static async find(id: string, caseId: string) {
    return prisma.caseMissingEvidence.findFirst({ where: { id, caseId } });
  }

  /** Open gaps first, then the most severe, so the panel leads with what still needs work. */
  static async list(caseId: string) {
    const rows = await prisma.caseMissingEvidence.findMany({ where: { caseId } });
    const byStatus = { OPEN: 0, RESOLVED: 1, DISMISSED: 2 } as const;
    const bySeverity = { CRITICAL: 0, MODERATE: 1, MINOR: 2 } as const;
    return rows.sort(
      (a, b) =>
        byStatus[a.status] - byStatus[b.status] ||
        bySeverity[a.severity] - bySeverity[b.severity] ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * #159: tags a gap as filled by an intake-time evidence upload. CW decides which gap the
   * uploaded evidence resolved (from its structured extraction) and passes that gap's id back
   * through ilovelawyer-api; this just records the link once the document's extraction has gone
   * READY. Deliberately does not touch `status` — that stays the lawyer's own call via
   * updateStatus below, so an intake fill surfaces as "evidence attached" without silently
   * marking the gap RESOLVED on the client's say-so alone.
   */
  /** The proofs suggested to the client from their story (CLIENT_INTAKE_EVIDENCE_NOTE), in the
   * order they were suggested. */
  static async listClientIntake(caseId: string) {
    return prisma.caseMissingEvidence.findMany({ where: { caseId, notes: CLIENT_INTAKE_EVIDENCE_NOTE }, orderBy: { createdAt: "asc" } });
  }

  /** Saves a case's suggestions unless it already has some: of two starts at once, the first set is
   * kept (an advisory lock on the case makes check-then-insert atomic). Returns the case's
   * suggestions either way. Each is stamped a millisecond apart so they keep their order. */
  static async createClientIntakeOnce(caseId: string, rows: ClientIntakeEvidenceRow[]) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyFor(`client-evidence:${caseId}`)})`;
      if (await tx.caseMissingEvidence.count({ where: { caseId, notes: CLIENT_INTAKE_EVIDENCE_NOTE } })) return;
      const now = Date.now();
      await tx.caseMissingEvidence.createMany({
        data: rows.map((row, i) => ({
          caseId,
          label: row.label,
          detail: row.detail,
          suggestedSource: row.suggestedSource,
          severity: MissingEvidenceSeverity.MODERATE,
          notes: CLIENT_INTAKE_EVIDENCE_NOTE,
          createdAt: new Date(now + i),
        })),
      });
    });
    return MissingEvidenceRepo.listClientIntake(caseId);
  }

  /** "I don't have this" on one of the client's suggestions, or undoing it (`at` null). False when the
   * id isn't one of this case's client suggestions. */
  static async setClientDismissed(id: string, caseId: string, at: Date | null): Promise<boolean> {
    const { count } = await prisma.caseMissingEvidence.updateMany({ where: { id, caseId, notes: CLIENT_INTAKE_EVIDENCE_NOTE }, data: { clientDismissedAt: at } });
    return count === 1;
  }

  /** A document the client removed no longer fills anything: the gaps it filled are open again (an
   * intake fill only; the lawyer's own triage, `status`, is left alone). */
  static async clearFilledByDocument(caseId: string, documentId: string) {
    await prisma.caseMissingEvidence.updateMany({
      where: { caseId, filledByDocumentId: documentId },
      data: { filledByDocumentId: null, filledAt: null, filledViaIntake: false },
    });
  }

  static async markFilledByDocument(id: string, caseId: string, documentId: string) {
    const existing = await prisma.caseMissingEvidence.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseMissingEvidence.update({
      where: { id },
      data: { filledByDocumentId: documentId, filledAt: new Date(), filledViaIntake: true },
    });
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
