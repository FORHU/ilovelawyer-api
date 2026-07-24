import prisma from "../lib/prisma";

export default class CaseRepo {
  static async create(userId: string, caseName: string, partyInvolved?: string, notes?: string) {
    return prisma.case.create({ data: { userId, caseName, partyInvolved, notes } });
  }

  static async list(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [total, rows] = await prisma.$transaction([
      prisma.case.count({ where: { userId } }),
      prisma.case.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    return { total, data: rows };
  }

  static async findById(id: string, userId: string) {
    return prisma.case.findFirst({ where: { id, userId } });
  }

  static async update(id: string, userId: string, data: { caseName?: string; partyInvolved?: string; notes?: string }) {
    const result = await prisma.case.updateMany({ where: { id, userId }, data });
    return result.count > 0;
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.case.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
}
