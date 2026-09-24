import prisma from "../lib/prisma";
import { PrivilegeStatus, HearsayCategory, ContradictionStatus, ContradictionNature } from "@prisma/client";

export default class EvidenceRepo {
  static async listMatrix(caseId: string) {
    return prisma.evidenceMatrixItem.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      include: { custodyEvents: { orderBy: { occurredAt: "desc" } } },
    });
  }

  static async upsertMatrix(
    caseId: string,
    documentId: string,
    data: {
      authenticity?: string;
      admissibility?: string;
      probative?: string;
      originalFile?: boolean;
      needsVerify?: boolean;
      notes?: string | null;
      privilegeStatus?: PrivilegeStatus;
      hearsayCategory?: HearsayCategory;
      sponsoringWitnessId?: string | null;
    },
  ) {
    return prisma.evidenceMatrixItem.upsert({
      where: { caseId_documentId: { caseId, documentId } },
      create: { caseId, documentId, ...data },
      update: data,
      include: { custodyEvents: { orderBy: { occurredAt: "desc" } } },
    });
  }

  static async findMatrixItem(caseId: string, documentId: string) {
    return prisma.evidenceMatrixItem.findUnique({ where: { caseId_documentId: { caseId, documentId } } });
  }

  static async addCustodyEvent(
    evidenceMatrixItemId: string,
    data: { custodianName: string; action: string; occurredAt: Date; notes?: string | null },
  ) {
    return prisma.evidenceCustodyEvent.create({ data: { evidenceMatrixItemId, ...data } });
  }

  static async deleteCustodyEvent(evidenceMatrixItemId: string, eventId: string) {
    const result = await prisma.evidenceCustodyEvent.deleteMany({
      where: { id: eventId, evidenceMatrixItemId },
    });
    return result.count > 0;
  }

  static async listContradictions(caseId: string) {
    return prisma.evidenceContradiction.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async replaceContradictions(
    caseId: string,
    rows: {
      kind: string;
      leftDocumentId: string;
      rightDocumentId: string;
      leftExcerpt: string;
      rightExcerpt: string;
      factKey: string;
      leftValue: string;
      rightValue: string;
      confidence: number;
      // Carried over from the previous scan's matching row, or set fresh — see
      // EvidenceIntelligenceSvc.scanContradictionsInner.
      status?: ContradictionStatus;
      resolutionNote?: string | null;
      resolvedAt?: Date | null;
      resolvedById?: string | null;
      nature?: ContradictionNature | null;
      natureConfidence?: number | null;
    }[],
  ) {
    await prisma.$transaction([
      prisma.evidenceContradiction.deleteMany({ where: { caseId } }),
      ...(rows.length
        ? [
            prisma.evidenceContradiction.createMany({
              data: rows.map((row) => ({ caseId, ...row })),
            }),
          ]
        : []),
    ]);
    return this.listContradictions(caseId);
  }

  static async updateContradictionStatus(
    id: string,
    caseId: string,
    data: { status: ContradictionStatus; resolutionNote: string | null; resolvedById: string | null },
  ) {
    const existing = await prisma.evidenceContradiction.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    const open = data.status === "OPEN";
    return prisma.evidenceContradiction.update({
      where: { id },
      data: {
        status: data.status,
        resolutionNote: open ? null : data.resolutionNote,
        resolvedAt: open ? null : new Date(),
        resolvedById: open ? null : data.resolvedById,
      },
    });
  }
}
