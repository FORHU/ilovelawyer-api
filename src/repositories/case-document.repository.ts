import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewCaseDocument {
  userId: string;
  caseId?: string;
  fileId: string;
  name: string;
  documentType?: string;
  fileSize?: number;
  mimeType?: string;
}

export default class CaseDocumentRepo {
  static async create(userId: string, data: { name: string; fileId: string; caseId?: string }) {
    return prisma.caseDocument.create({ data: { userId, ...data } });
  }

  static async createManyAndReturn(items: NewCaseDocument[], client: DbClient = prisma) {
    return client.caseDocument.createManyAndReturn({ data: items });
  }

  static async list(userId: string) {
    return prisma.caseDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async listByCase(userId: string, caseId: string) {
    return prisma.caseDocument.findMany({
      where: { userId, caseId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.caseDocument.findFirst({ where: { id, userId } });
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null }) {
    const result = await prisma.caseDocument.updateMany({ where: { id, userId }, data });
    return result.count > 0;
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.caseDocument.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
}
