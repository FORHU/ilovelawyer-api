import prisma from "../lib/prisma";

export default class EvidenceRepo {
  static async listMatrix(caseId: string) {
    return prisma.evidenceMatrixItem.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
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
    },
  ) {
    return prisma.evidenceMatrixItem.upsert({
      where: { caseId_documentId: { caseId, documentId } },
      create: { caseId, documentId, ...data },
      update: data,
    });
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
}
