import { Prisma } from "@prisma/client";
import { PackageSku, WorkspacePreset } from "@prisma/client";
import TerminalWorkspaceRepo from "../repositories/terminal-workspace.repository";
import CaseRiskRepo from "../repositories/case-risk.repository";
import { PANEL_CATALOG, skuAllowsPanel, defaultPresetForSku } from "../constants/terminal.constants";
import { buildDefaultLayout, normalizeLayout } from "../utils/terminal-layout";
import HttpError from "../utils/http-error";
import prisma from "../lib/prisma";

export default class TerminalWorkspaceSvc {
  static catalog(sku: string = "SOLO") {
    return {
      panels: PANEL_CATALOG.map((panel) => ({
        ...panel,
        available: skuAllowsPanel(sku, panel.minSku),
      })),
      presets: ["PANE_1", "PANE_2", "PANE_4", "PANE_6"],
      defaultPreset: defaultPresetForSku(sku),
    };
  }

  static async list(userId: string) {
    return TerminalWorkspaceRepo.list(userId);
  }

  static async getById(id: string, userId: string) {
    const row = await TerminalWorkspaceRepo.findById(id, userId);
    if (!row) throw new HttpError("Workspace not found", 404);
    return row;
  }

  static async create(userId: string, sku: string, body: { name: string; preset?: WorkspacePreset; layoutJson?: unknown }) {
    const preset = body.preset ?? defaultPresetForSku(sku);
    const layoutJson = normalizeLayout(body.layoutJson ?? buildDefaultLayout(preset, sku), sku) as unknown as Prisma.InputJsonValue;
    return TerminalWorkspaceRepo.create(userId, {
      name: body.name,
      preset,
      layoutJson,
    });
  }

  static async update(
    id: string,
    userId: string,
    sku: string,
    body: { name?: string; preset?: WorkspacePreset; layoutJson?: unknown; isLastUsed?: boolean },
  ) {
    const data: { name?: string; preset?: WorkspacePreset; layoutJson?: Prisma.InputJsonValue; isLastUsed?: boolean } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.preset !== undefined) data.preset = body.preset;
    if (body.layoutJson !== undefined) data.layoutJson = normalizeLayout(body.layoutJson, sku) as unknown as Prisma.InputJsonValue;
    if (body.isLastUsed !== undefined) data.isLastUsed = body.isLastUsed;
    const updated = await TerminalWorkspaceRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Workspace not found", 404);
    return updated;
  }

  static async apply(id: string, userId: string) {
    const updated = await TerminalWorkspaceRepo.markLastUsed(id, userId);
    if (!updated) throw new HttpError("Workspace not found", 404);
    return updated;
  }

  static async resetToPreset(userId: string, sku: string, preset?: WorkspacePreset) {
    const resolved = preset ?? defaultPresetForSku(sku);
    return TerminalWorkspaceRepo.create(userId, {
      name: `Default ${resolved.replace("_", " ")}`,
      preset: resolved,
      layoutJson: buildDefaultLayout(resolved, sku) as unknown as Prisma.InputJsonValue,
    });
  }

  static async delete(id: string, userId: string) {
    const deleted = await TerminalWorkspaceRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Workspace not found", 404);
  }

  static async metrics(userId: string) {
    const [workspaceSaves, risksWithSource, risksTotal, user] = await Promise.all([
      TerminalWorkspaceRepo.countForUser(userId),
      CaseRiskRepo.countWithSource(),
      CaseRiskRepo.countAll(),
      prisma.user.findUnique({ where: { id: userId }, select: { packageSku: true } }),
    ]);
    return {
      workspaceSaves,
      risksWithSource,
      risksTotal,
      sourceLinkRate: risksTotal === 0 ? null : risksWithSource / risksTotal,
      packageSku: user?.packageSku ?? "SOLO",
    };
  }

  static async skuForUser(userId: string): Promise<PackageSku> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { packageSku: true } });
    return user?.packageSku ?? "SOLO";
  }
}
