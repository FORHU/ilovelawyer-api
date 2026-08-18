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
  /**
   * userId is stamped for "created by" audit purposes only — every read/update/delete
   * below scopes by organizationId, since a Case is a shared org resource once created.
   */
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    const { parties, ...caseFields } = data;

    return prisma.case.create({
      data: {
        organizationId,
        userId,
        ...caseFields,
        parties: parties ? { create: parties } : undefined,
      },
      include: { parties: true },
    });
  }

  static async list(organizationId: string, page: number, limit: number, search?: string) {
    const skip = (page - 1) * limit;

    const where = {
      organizationId,
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

  static async findById(id: string, organizationId: string) {
    return prisma.case.findFirst({ where: { id, organizationId }, include: { parties: true } });
  }

  static async update(id: string, organizationId: string, data: CaseData) {
    const { parties, ...caseFields } = data;

    const existing = await prisma.case.findFirst({ where: { id, organizationId }, select: { id: true } });
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

  static async delete(id: string, organizationId: string) {
    const result = await prisma.case.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }
}
