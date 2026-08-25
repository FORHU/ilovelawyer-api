import prisma from "../lib/prisma";

export default class EventRepo {
  /**
   * clientEmail matching lets an event be found by the client's email even though they're not
   * an org member — kept as an OR alongside userId, but both are still nested inside a hard
   * organizationId AND so a match can never cross an org boundary.
   */
  static async findMany(organizationId: string, userId: string, userEmail: string, filters: {
    startRange?: string;
    endRange?: string;
    excludeId?: string;
    excludeStatus?: string;
    limitOne?: boolean;
    caseId?: string;
  } = {}) {
    const andConditions: any[] = [
      { organizationId },
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

  static async findById(id: string, organizationId: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        id,
        organizationId,
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

  static async findByGoogleEventId(googleEventId: string, organizationId: string, userId: string, userEmail: string) {
    return prisma.event.findFirst({
      where: {
        googleEventId,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
    });
  }

  static async create(organizationId: string, userId: string, data: {
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
    return prisma.event.create({ data: { organizationId, userId, ...data } });
  }

  static async updateById(id: string, organizationId: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        id,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  static async updateByGoogleEventId(googleEventId: string, organizationId: string, userId: string, userEmail: string, data: object) {
    return prisma.event.updateMany({
      where: {
        googleEventId,
        organizationId,
        OR: [
          { userId },
          { clientEmail: { contains: userEmail, mode: "insensitive" } },
        ],
      },
      data,
    });
  }

  static async upsertByGoogleEventId(organizationId: string, userId: string, googleEventId: string, createData: any, updateData: any) {
    return prisma.event.upsert({
      where: { googleEventId_userId: { googleEventId, userId } },
      create: { organizationId, userId, googleEventId, ...createData },
      update: updateData,
    });
  }

  static async deleteById(id: string, organizationId: string, userId: string) {
    return prisma.event.deleteMany({ where: { id, organizationId, userId } });
  }

  static async deleteByGoogleEventId(googleEventId: string, organizationId: string, userId: string) {
    return prisma.event.deleteMany({ where: { googleEventId, organizationId, userId } });
  }

  static async deleteManyByGoogleEventIds(organizationId: string, userId: string, googleEventIds: string[]) {
    return prisma.event.deleteMany({
      where: { organizationId, userId, googleEventId: { in: googleEventIds } },
    });
  }

  static async findFirstLocal(organizationId: string, userId: string, title: string, dateTime: Date) {
    return prisma.event.findFirst({
      where: { organizationId, userId, googleEventId: null, title, dateTime },
    });
  }
}
