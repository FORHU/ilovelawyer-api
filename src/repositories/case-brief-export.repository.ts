import prisma from "../lib/prisma";

export default class CaseBriefExportRepo {
  static async create(caseId: string, userId: string, format: string, fileId: string) {
    return prisma.caseBriefExport.create({ data: { caseId, userId, format, fileId } });
  }

  /** Most recent first — a lawyer checking history wants "what did I just make", not chronological
   * order. Includes the related File row (for name/s3Key) since the list needs to mint a fresh
   * presigned URL per entry — the one from generation time may have already expired.
   * Cursor-paginated (same shape as NotificationRepo.findMany) for infinite-scroll, not numbered
   * pages — `id` tiebreaker keeps ordering stable when several entries share a `createdAt`
   * (a Generate click fires docx+pdf in parallel, so ties are the common case here, not an edge
   * case). */
  static async listByCase(caseId: string, filters: { limit?: number; cursor?: string } = {}) {
    const limit = filters.limit ?? 20;
    return prisma.caseBriefExport.findMany({
      where: { caseId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { file: true },
      take: limit,
      ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    });
  }
}
