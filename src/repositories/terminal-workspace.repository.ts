import prisma from "../lib/prisma";
import { WorkspacePreset } from "@prisma/client";
import { Prisma } from "@prisma/client";

export default class TerminalWorkspaceRepo {
  static async list(userId: string) {
    return prisma.terminalWorkspace.findMany({
      where: { userId },
      orderBy: [{ isLastUsed: "desc" }, { updatedAt: "desc" }],
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.terminalWorkspace.findFirst({ where: { id, userId } });
  }

  static async create(userId: string, data: { name: string; preset: WorkspacePreset; layoutJson: Prisma.InputJsonValue }) {
    return prisma.$transaction(async (tx) => {
      await tx.terminalWorkspace.updateMany({ where: { userId, isLastUsed: true }, data: { isLastUsed: false } });
      return tx.terminalWorkspace.create({
        data: { userId, ...data, isLastUsed: true },
      });
    });
  }

  static async update(
    id: string,
    userId: string,
    data: { name?: string; preset?: WorkspacePreset; layoutJson?: Prisma.InputJsonValue; isLastUsed?: boolean },
  ) {
    const existing = await prisma.terminalWorkspace.findFirst({ where: { id, userId }, select: { id: true } });
    if (!existing) return null;

    return prisma.$transaction(async (tx) => {
      if (data.isLastUsed) {
        await tx.terminalWorkspace.updateMany({ where: { userId, isLastUsed: true }, data: { isLastUsed: false } });
      }
      return tx.terminalWorkspace.update({ where: { id }, data });
    });
  }

  static async markLastUsed(id: string, userId: string) {
    return this.update(id, userId, { isLastUsed: true });
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.terminalWorkspace.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }

  static async countForUser(userId: string) {
    return prisma.terminalWorkspace.count({ where: { userId } });
  }
}
