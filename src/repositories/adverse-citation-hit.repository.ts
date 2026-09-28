import { AdverseHitKind, CitationTreatment, Prisma, SuggestionStatus } from "@prisma/client";
import prisma from "../lib/prisma";

export interface NewAdverseHit {
  citationCheckId: string;
  kind: AdverseHitKind;
  edgeId: string | null;
  treatment: CitationTreatment | null;
  citingTitle: string | null;
  excerpt: string | null;
  jev?: Prisma.InputJsonValue;
  jevCheckedAt?: Date | null;
}

/** Same hit across sweeps: the authority plus the corpus edge behind it (none for OWN_STATUS). */
export function hitKey(hit: { citationCheckId: string; edgeId: string | null }): string {
  return `${hit.citationCheckId}:${hit.edgeId ?? "own"}`;
}

export default class AdverseCitationHitRepo {
  static async list(caseId: string) {
    return prisma.adverseCitationHit.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  }

  static async find(id: string, caseId: string) {
    return prisma.adverseCitationHit.findFirst({ where: { id, caseId } });
  }

  static async setDecision(id: string, suggestionStatus: SuggestionStatus, weaknessId: string | null) {
    return prisma.adverseCitationHit.update({ where: { id }, data: { suggestionStatus, weaknessId } });
  }

  /** Replaces the case's hits with a fresh sweep's, carrying each hit's accept/dismiss decision
   * (and the Weakness it created) over to the same hit found again. */
  static async replace(caseId: string, hits: NewAdverseHit[]) {
    await prisma.$transaction(async (tx) => {
      const previous = await tx.adverseCitationHit.findMany({ where: { caseId } });
      const decided = new Map(previous.map((h) => [hitKey(h), h]));
      await tx.adverseCitationHit.deleteMany({ where: { caseId } });
      if (hits.length === 0) return;
      await tx.adverseCitationHit.createMany({
        data: hits.map((hit) => {
          const before = decided.get(hitKey(hit));
          return {
            ...hit,
            caseId,
            suggestionStatus: before?.suggestionStatus ?? "PENDING",
            weaknessId: before?.weaknessId ?? null,
          };
        }),
      });
    });
    return this.list(caseId);
  }
}
