import prisma from "../lib/prisma";

export default class UserDocumentRepo {
  static async create(userId: string, data: { name: string; fileUrl: string; s3Key: string; caseId?: string }) {
    return prisma.userDocument.create({ data: { userId, ...data } });
  }

  static async list(userId: string) {
    return prisma.userDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async listByCase(userId: string, caseId: string) {
    return prisma.userDocument.findMany({
      where: { userId, caseId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.userDocument.findFirst({ where: { id, userId } });
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null; aiSummary?: string }) {
    const result = await prisma.userDocument.updateMany({ where: { id, userId }, data });
    return result.count > 0;
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.userDocument.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }

  static async updateRagStatus(id: string, ragStatus: "PENDING" | "READY" | "FAILED") {
    return prisma.userDocument.update({ where: { id }, data: { ragStatus } });
  }
}
