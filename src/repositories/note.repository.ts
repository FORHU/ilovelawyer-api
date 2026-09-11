import prisma from "../lib/prisma";

export default class NoteRepo {
  static async findMany(organizationId: string, userId: string, filters: { from?: string; to?: string } = {}) {
    const andConditions: any[] = [{ organizationId }, { userId }];

    if (filters.from) andConditions.push({ date: { gte: new Date(`${filters.from}T00:00:00.000Z`) } });
    if (filters.to) andConditions.push({ date: { lte: new Date(`${filters.to}T23:59:59.999Z`) } });

    return prisma.note.findMany({
      where: { AND: andConditions },
      orderBy: { date: "asc" },
    });
  }

  static async create(organizationId: string, userId: string, data: { date: Date; body: string }) {
    return prisma.note.create({ data: { organizationId, userId, ...data } });
  }
}
