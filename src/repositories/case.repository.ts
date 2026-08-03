import prisma from "../lib/prisma";

export interface PartyInput {
  name: string;
  designation: string;
}

export interface CaseData {
  caseName?: string;
  actionType?: string;
  jurisdiction?: string;
  notes?: string;
  parties?: PartyInput[];
}

export default class CaseRepo {
  static async create(userId: string, data: CaseData & { caseName: string }) {
    const { parties, ...caseFields } = data;

    return prisma.case.create({
      data: {
        userId,
        ...caseFields,
        parties: parties ? { create: parties } : undefined,
      },
      include: { parties: true },
    });
  }

  static async list(userId: string, page: number, limit: number, search?: string) {
    const skip = (page - 1) * limit;

    const where = {
      userId,
      ...(search
        ? {
            OR: [
              { caseName: { contains: search, mode: "insensitive" as const } },
              { parties: { some: { name: { contains: search, mode: "insensitive" as const } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await prisma.$transaction([
      prisma.case.count({ where }),
      prisma.case.findMany({
        where,
        skip,
        take: limit,
        orderBy: { updatedAt: "desc" },
        include: { parties: true },
      }),
    ]);

    return { total, data: rows };
  }

  static async findById(id: string, userId: string) {
    return prisma.case.findFirst({ where: { id, userId }, include: { parties: true } });
  }

  static async update(id: string, userId: string, data: CaseData) {
    const { parties, ...caseFields } = data;

    const existing = await prisma.case.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return false;

    await prisma.$transaction(async (tx) => {
      await tx.case.update({ where: { id }, data: caseFields });

      if (parties) {
        await tx.party.deleteMany({ where: { caseId: id } });
        if (parties.length > 0) {
          await tx.party.createMany({ data: parties.map((p) => ({ ...p, caseId: id })) });
        }
      }
    });

    return true;
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.case.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
}
