import prisma from "../lib/prisma";
import { Prisma, RagStatus } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewUserDocument {
  userId: string;
  caseId?: string;
  fileId: string;
  name: string;
  documentType?: string;
  fileSize?: number;
  mimeType?: string;
}

export default class DocumentRepo {
  static async create(userId: string, data: { name: string; fileId: string; caseId?: string; consultationId?: string }) {
    return prisma.document.create({ data: { userId, ...data } });
  }

  static async createManyAndReturn(items: NewUserDocument[], client: DbClient = prisma) {
    return client.document.createManyAndReturn({ data: items });
  }

  static async list(userId: string) {
    return prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async listByCase(userId: string, caseId: string) {
    return prisma.document.findMany({
      where: { userId, caseId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.document.findFirst({ where: { id, userId } });
  }

  /** Unscoped by userId — used internally by extraction dispatch, which only ever receives an id
   * of a document it just created/confirmed itself, not a user-supplied id. */
  static async findByIdWithFile(id: string) {
    return prisma.document.findUnique({ where: { id }, include: { file: true } });
  }

  /** Most recently attached document for a consultation — lets chat auto-ground later turns
   * against it without the client having to re-pass caseDocumentId on every message. */
  static async findMostRecentByConsultation(consultationId: string) {
    return prisma.document.findFirst({ where: { consultationId }, orderBy: { createdAt: "desc" } });
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null }) {
    const result = await prisma.document.updateMany({ where: { id, userId }, data });
    return result.count > 0;
  }

  static async updateRagStatus(id: string, ragStatus: RagStatus) {
    return prisma.document.update({ where: { id }, data: { ragStatus } });
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.document.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
}
