import prisma from "../lib/prisma";

export default class CaseBriefExportRepo {
  static async create(caseId: string, userId: string, format: string, fileId: string) {
    return prisma.caseBriefExport.create({ data: { caseId, userId, format, fileId } });
  }

  /** Most recent first — a lawyer checking history wants "what did I just make", not chronological
   * order. Includes the related File row (for name/s3Key) since the list needs to mint a fresh
   * presigned URL per entry — the one from generation time may have already expired. */
  static async listByCase(caseId: string) {
    return prisma.caseBriefExport.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }
}
