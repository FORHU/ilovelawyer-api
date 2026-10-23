import prisma from "../lib/prisma";
import { organizationIdOf, scopeWhere, type WorkspaceScope } from "../utils/workspace";

/** A lawyer's own calendar notes, in a firm or in their own workspace. */
export default class NoteRepo {
  static async findMany(scope: WorkspaceScope, userId: string, filters: { from?: string; to?: string } = {}) {
    const andConditions: any[] = [scopeWhere(scope), { userId }];

    if (filters.from) andConditions.push({ date: { gte: new Date(`${filters.from}T00:00:00.000Z`) } });
    if (filters.to) andConditions.push({ date: { lte: new Date(`${filters.to}T23:59:59.999Z`) } });

    return prisma.note.findMany({
      where: { AND: andConditions },
      orderBy: { date: "asc" },
    });
  }

  static async create(scope: WorkspaceScope, userId: string, data: { date: Date; body: string }) {
    return prisma.note.create({ data: { organizationId: organizationIdOf(scope), userId, ...data } });
  }

  static async updateById(id: string, scope: WorkspaceScope, userId: string, data: { date?: Date; body?: string }) {
    return prisma.note.updateMany({ where: { id, ...scopeWhere(scope), userId }, data });
  }

  static async deleteById(id: string, scope: WorkspaceScope, userId: string) {
    return prisma.note.deleteMany({ where: { id, ...scopeWhere(scope), userId } });
  }
}
