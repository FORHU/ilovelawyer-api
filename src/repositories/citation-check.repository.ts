import prisma from "../lib/prisma";
import { CitationValidityStatus, CitationPropositionType } from "@prisma/client";

export default class CitationCheckRepo {
  static async list(caseId: string) {
    return prisma.citationCheck.findMany({ where: { caseId }, orderBy: { checkedAt: "desc" } });
  }

  static async create(
    caseId: string,
    data: {
      quotedText: string;
      citedReference?: string | null;
      sourceUrl?: string | null;
      officialText?: string | null;
      status: CitationValidityStatus;
      notes: string;
      resolvedLawId?: string | null;
      resolutionConfidence?: number | null;
      pinpoint?: string | null;
      propositionType?: CitationPropositionType | null;
    },
  ) {
    return prisma.citationCheck.create({ data: { caseId, ...data } });
  }

  /** Scoped by caseId so an id from another case can never be read, changed or removed. */
  static async findInCase(id: string, caseId: string) {
    return prisma.citationCheck.findFirst({ where: { id, caseId } });
  }

  static async update(
    id: string,
    caseId: string,
    data: {
      quotedText: string;
      citedReference: string | null;
      sourceUrl: string | null;
      officialText: string | null;
      status: CitationValidityStatus;
      notes: string;
      resolvedLawId: string | null;
      resolutionConfidence: number | null;
      pinpoint: string | null;
      propositionType: CitationPropositionType | null;
    },
  ) {
    const existing = await prisma.citationCheck.findFirst({ where: { id, caseId }, select: { id: true } });
    if (!existing) return null;
    return prisma.citationCheck.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.citationCheck.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  /** Caches a citation's resolution against the Law corpus (see CitationMapSvc.getSeed) so
   * repeat views of a case's Citation Map don't re-run the same search every time a resolved
   * match was already found. An unresolved attempt (both args null) is intentionally NOT
   * distinguished from "never attempted" — re-trying an unresolved citation on a later view is
   * cheap (LawSvc.search is local-first) and lets a citation resolve later if the Law corpus
   * grows in the meantime. */
  static async markResolved(id: string, lawId: string | null, confidence: number | null) {
    return prisma.citationCheck.update({ where: { id }, data: { resolvedLawId: lawId, resolutionConfidence: confidence } });
  }
}
