import prisma from "../lib/prisma";
import { Prisma, RagStatus } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewUserDocument {
  organizationId: string;
  userId: string;
  caseId?: string;
  consultationId?: string;
  fileId: string;
  name: string;
  documentType?: string;
  fileSize?: number;
  mimeType?: string;
}

export default class DocumentRepo {
  /** userId is stamped for "created by" audit purposes only — reads/updates/deletes below scope by organizationId. */
  static async create(
    organizationId: string,
    userId: string,
    data: { name: string; fileId: string; caseId?: string; consultationId?: string; mimeType?: string },
  ) {
    return prisma.document.create({ data: { organizationId, userId, ...data }, include: { file: true } });
  }

  /** No `include` here — createManyAndReturn only supports including relations under Prisma's
   * relationJoins preview feature, which this project doesn't enable. Callers already have the
   * just-created File rows in scope (same transaction) and merge fileUrl in manually. */
  static async createManyAndReturn(items: NewUserDocument[], client: DbClient = prisma) {
    return client.document.createManyAndReturn({ data: items });
  }

  static async list(organizationId: string) {
    return prisma.document.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  static async listByCase(organizationId: string, caseId: string) {
    return prisma.document.findMany({
      where: { organizationId, caseId },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  static async listAllByCase(caseId: string) {
    return prisma.document.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async listByConsultation(organizationId: string, consultationId: string) {
    return prisma.document.findMany({
      where: { organizationId, consultationId },
      orderBy: { createdAt: "desc" },
      include: { file: true },
    });
  }

  /** PENDING docs that should be extracted — used to re-queue work after a process restart. */
  static async listPendingForExtraction() {
    return prisma.document.findMany({
      where: {
        ragStatus: "PENDING",
        OR: [{ caseId: { not: null } }, { consultationId: { not: null } }],
      },
      select: { id: true },
    });
  }

  static async countPendingExtractionByCase(caseId: string) {
    return prisma.document.count({
      where: { caseId, ragStatus: "PENDING" },
    });
  }

  static async countReadyByConsultation(consultationId: string) {
    return prisma.document.count({
      where: { consultationId, ragStatus: "READY" },
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.document.findFirst({ where: { id, organizationId }, include: { file: true } });
  }

  /** Links documents already uploaded (via presign + confirm) to the message they were sent
   * alongside. Scoped to organizationId and consultationId so a caller can't link someone else's
   * document, or one from a different consultation, by guessing an id. */
  static async linkToMessage(ids: string[], messageId: string, organizationId: string, consultationId: string) {
    await prisma.document.updateMany({ where: { id: { in: ids }, organizationId, consultationId }, data: { messageId } });
  }

  /** Unscoped by organizationId — used internally by extraction dispatch, which only ever receives an id
   * of a document it just created/confirmed itself, not a user-supplied id. */
  static async findByIdWithFile(id: string) {
    return prisma.document.findUnique({ where: { id }, include: { file: true } });
  }

  /** Most recently attached document for a consultation — lets chat auto-ground later turns
   * against it without the client having to re-pass caseDocumentId on every message. */
  static async findMostRecentByConsultation(consultationId: string) {
    return prisma.document.findFirst({ where: { consultationId }, orderBy: { createdAt: "desc" } });
  }

  static async update(id: string, organizationId: string, data: { name?: string; caseId?: string | null; consultationId?: string | null }) {
    const result = await prisma.document.updateMany({ where: { id, organizationId }, data });
    return result.count > 0;
  }

  static async updateRagStatus(id: string, ragStatus: RagStatus) {
    return prisma.document.update({ where: { id }, data: { ragStatus } });
  }

  static async updateExtractionMeta(
    id: string,
    data: { pageCount?: number | null; extractionMethod?: string | null; ocrAttempted?: boolean; language?: string },
  ) {
    return prisma.document.update({ where: { id }, data });
  }

  static async delete(id: string, organizationId: string) {
    const result = await prisma.document.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }
}
