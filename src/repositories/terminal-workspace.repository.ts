import prisma from "../lib/prisma";
import { WorkspacePreset } from "@prisma/client";
import { Prisma } from "@prisma/client";

type WorkspaceRow = Prisma.TerminalWorkspaceGetPayload<object>;

/** Layouts are shared by everyone on the case; which one a person last had open is theirs alone
 * (TerminalWorkspaceSelection). Every row handed back carries `isLastUsed` for the caller, the
 * shape the app has always read. */
export default class TerminalWorkspaceRepo {
  private static async lastUsedId(userId: string, caseId: string | null) {
    if (!caseId) return null;
    const selection = await prisma.terminalWorkspaceSelection.findUnique({ where: { userId_caseId: { userId, caseId } }, select: { workspaceId: true } });
    return selection?.workspaceId ?? null;
  }

  private static async withLastUsed(row: WorkspaceRow, userId: string) {
    return { ...row, isLastUsed: row.id === (await this.lastUsedId(userId, row.caseId)) };
  }

  static async list(userId: string, caseId: string) {
    // Stable creation order, not isLastUsed/updatedAt — those change on every select/apply,
    // which was reshuffling the tab strip out from under whatever the user just clicked.
    // isLastUsed still exists for "which tab to restore on page load" (read elsewhere), it just
    // no longer drives display order.
    const [rows, lastUsedId] = await Promise.all([
      prisma.terminalWorkspace.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
      this.lastUsedId(userId, caseId),
    ]);
    return rows.map((row) => ({ ...row, isLastUsed: row.id === lastUsedId }));
  }

  /** The bare row, for the access check — whoever's case it is decides who may reach it. */
  static async findRow(id: string) {
    return prisma.terminalWorkspace.findUnique({ where: { id } });
  }

  static async findById(id: string, userId: string) {
    const row = await this.findRow(id);
    return row ? this.withLastUsed(row, userId) : null;
  }

  static async create(userId: string, data: { caseId: string; name: string; preset: WorkspacePreset; layoutJson: Prisma.InputJsonValue }) {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.terminalWorkspace.create({ data: { userId, ...data } });
      await tx.terminalWorkspaceSelection.upsert({
        where: { userId_caseId: { userId, caseId: data.caseId } },
        create: { userId, caseId: data.caseId, workspaceId: created.id },
        update: { workspaceId: created.id },
      });
      return created;
    });
    return { ...row, isLastUsed: true };
  }

  static async update(id: string, userId: string, data: { name?: string; preset?: WorkspacePreset; layoutJson?: Prisma.InputJsonValue }) {
    const row = await prisma.terminalWorkspace.update({ where: { id }, data });
    return this.withLastUsed(row, userId);
  }

  /** Scoped to this workspace's own case — "last used" tracks per-case, so applying a layout in
   * one case must not change which layout was last used in a different case. */
  static async markLastUsed(id: string, userId: string) {
    const row = await this.findRow(id);
    if (!row) return null;
    if (row.caseId) {
      await prisma.terminalWorkspaceSelection.upsert({
        where: { userId_caseId: { userId, caseId: row.caseId } },
        create: { userId, caseId: row.caseId, workspaceId: id },
        update: { workspaceId: id },
      });
    }
    return { ...row, isLastUsed: true };
  }

  static async delete(id: string) {
    const result = await prisma.terminalWorkspace.deleteMany({ where: { id } });
    return result.count > 0;
  }

  static async countForUser(userId: string) {
    return prisma.terminalWorkspace.count({ where: { userId } });
  }
}
