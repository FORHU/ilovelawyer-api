import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import HttpError from "../utils/http-error";
import { dropUnknownPanelIds, normalizeScreenPresetScreens } from "../utils/screen-preset";
import TerminalWorkspaceSvc from "./terminal-workspace.service";

export default class ScreenPresetSvc {
  // System presets (userId: null, seeded — see prisma/seeders/screen-preset-grouped.seeder.ts) unioned
  // with this caller's own. A system preset is written for an exact screen count, so it only matches that count. The
  // caller's own workflow is whatever they built (often fewer screens than they have monitors), so it matches every
  // count it fits on. A user never sees another user's presets.
  static async list(userId: string, screenCount?: number) {
    const rows = await prisma.screenPreset.findMany({
      where: {
        OR: [
          { userId: null, ...(screenCount !== undefined ? { screenCount } : {}) },
          { userId, ...(screenCount !== undefined ? { screenCount: { lte: screenCount } } : {}) },
        ],
      },
      orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({ ...row, screens: dropUnknownPanelIds(row.screens) as typeof row.screens }));
  }

  // Always owned by the caller — a userId: null (system) row is only ever written by the seeder,
  // never through this API.
  static async create(userId: string, body: { name: string; description?: string; screens: unknown }) {
    const sku = await TerminalWorkspaceSvc.skuForUser(userId);
    const { screens, screenCount } = normalizeScreenPresetScreens(body.screens, sku);
    return prisma.screenPreset.create({
      data: {
        userId,
        name: body.name,
        description: body.description || null,
        screenCount,
        screens: screens as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Ownership-checked the same way TerminalWorkspaceSvc.update/delete are: a system preset's
  // userId (null) never matches a caller's userId, so it 404s here rather than needing a separate
  // admin-only check.
  static async update(id: string, userId: string, body: { name?: string; description?: string; screens?: unknown }) {
    const existing = await prisma.screenPreset.findFirst({ where: { id, userId } });
    if (!existing) throw new HttpError("Preset not found", 404);

    const data: { name?: string; description?: string | null; screens?: Prisma.InputJsonValue; screenCount?: number } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.screens !== undefined) {
      const sku = await TerminalWorkspaceSvc.skuForUser(userId);
      const { screens, screenCount } = normalizeScreenPresetScreens(body.screens, sku);
      data.screens = screens as unknown as Prisma.InputJsonValue;
      data.screenCount = screenCount;
    }
    return prisma.screenPreset.update({ where: { id }, data });
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.screenPreset.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new HttpError("Preset not found", 404);
  }
}
