import prisma from "../lib/prisma";

export default class EventRepo {
  static async findMany(userId: string, userEmail: string, filters: {
    startRange?: string;
    endRange?: string;
    excludeId?: string;
    excludeStatus?: string;
    limitOne?: boolean;
    caseId?: string;
  } = {}) {
    const andConditions: any[] = [
      {
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
    ];

    if (filters.startRange) andConditions.push({ dateTime: { gte: new Date(filters.startRange) } });
    if (filters.endRange) andConditions.push({ dateTime: { lte: new Date(filters.endRange) } });
    if (filters.excludeId) andConditions.push({ id: { not: filters.excludeId } });
    if (filters.excludeStatus) andConditions.push({ status: { not: filters.excludeStatus } });
    if (filters.caseId) andConditions.push({ caseId: filters.caseId });

    return prisma.event.findMany({
      where: { AND: andConditions },
      include: {
        user: { select: { id: true, email: true, name: true, username: true } },
      },
      ...(filters.limitOne && { take: 1 }),
      orderBy: { dateTime: "asc" },
    });
  }

  static async findById(id: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        id,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      include: {
        user: { select: { id: true, email: true, name: true, username: true } },
      },
    });
  }

  static async findByGoogleEventId(googleEventId: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        googleEventId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
    });
  }

  static async create(userId: string, data: {
    title: string;
    type?: string;
    dateTime: Date;
    clientEmail?: string;
    notes?: string;
    status?: string;
    googleLink?: string;
    googleEventId?: string;
    caseId?: string;
    dateSource?: string;
  }) {
    return prisma.event.create({ data: { userId, ...data } });
  }

  static async updateById(id: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        id,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  static async updateByGoogleEventId(googleEventId: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        googleEventId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  static async upsertByGoogleEventId(userId: string, googleEventId: string, createData: any, updateData: any) {
    return prisma.event.upsert({
      where: { googleEventId_userId: { googleEventId, userId } },
      create: { userId, googleEventId, ...createData },
      update: updateData,
    });
  }

  static async deleteById(id: string, userId: string) {
    return prisma.event.deleteMany({ where: { id, userId } });
  }

  static async deleteByGoogleEventId(googleEventId: string, userId: string) {
    return prisma.event.deleteMany({ where: { googleEventId, userId } });
  }

  static async deleteManyByGoogleEventIds(userId: string, googleEventIds: string[]) {
    return prisma.event.deleteMany({
      where: { userId, googleEventId: { in: googleEventIds } },
    });
  }

  static async findFirstLocal(userId: string, title: string, dateTime: Date) {
    return prisma.event.findFirst({
      where: { userId, googleEventId: null, title, dateTime },
    });
  }
}
