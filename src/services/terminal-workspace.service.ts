import { Prisma } from "@prisma/client";
import { PackageSku, WorkspacePreset } from "@prisma/client";
import TerminalWorkspaceRepo from "../repositories/terminal-workspace.repository";
import CaseRiskRepo from "../repositories/case-risk.repository";
import { PANEL_CATALOG, skuAllowsPanel, defaultPresetForSku } from "../constants";
import { buildDefaultLayout, dropUnknownPanelsFromLayout, normalizeLayout, regroupLayoutOnce, tabsToColumns } from "../utils/terminal-layout";
import HttpError from "../utils/http-error";
import CaseAccess from "../utils/case-access";
import prisma from "../lib/prisma";

export default class TerminalWorkspaceSvc {
  /** A stored row with its layout cleaned of panes the Terminal no longer has. The same row object comes back when there is
   * nothing to drop. Every method that returns a STORED layout goes through this; create and resetToPreset return layouts that
   * were just built, so they are already clean. */
  private static clean<T extends { layoutJson: unknown }>(row: T): T {
    const layoutJson = regroupLayoutOnce(dropUnknownPanelsFromLayout(tabsToColumns(row.layoutJson)));
    return layoutJson === row.layoutJson ? row : { ...row, layoutJson };
  }

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

  /** A layout is reached through its case: anyone who can open the case may see it, and anyone
   * who may add to the case (CaseAccess.assertCanContribute) may change it — so a member's rename
   * is what everyone else on the case sees. A layout saved before case-scoping has no case and
   * stays its creator's alone. 404 either way, so an id doesn't reveal a case. */
  private static async assertCan(action: "view" | "change", id: string, userId: string) {
    const row = await TerminalWorkspaceRepo.findRow(id);
    if (!row) throw new HttpError("Workspace not found", 404);
    if (!row.caseId) {
      if (row.userId !== userId) throw new HttpError("Workspace not found", 404);
      return;
    }
    if (action === "view") await CaseAccess.loadAccessibleCase(row.caseId, userId);
    else await CaseAccess.assertCanContribute(row.caseId, userId);
  }

  static async list(userId: string, caseId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return (await TerminalWorkspaceRepo.list(userId, caseId)).map((row) => TerminalWorkspaceSvc.clean(row));
  }

  static async getById(id: string, userId: string) {
    await TerminalWorkspaceSvc.assertCan("view", id, userId);
    const row = await TerminalWorkspaceRepo.findById(id, userId);
    if (!row) throw new HttpError("Workspace not found", 404);
    return TerminalWorkspaceSvc.clean(row);
  }

  static async create(userId: string, sku: string, body: { caseId: string; name: string; preset?: WorkspacePreset; layoutJson?: unknown }) {
    await CaseAccess.assertCanContribute(body.caseId, userId);
    const preset = body.preset ?? defaultPresetForSku(sku);
    const layoutJson = normalizeLayout(body.layoutJson ?? buildDefaultLayout(preset, sku), sku) as unknown as Prisma.InputJsonValue;
    return TerminalWorkspaceRepo.create(userId, {
      caseId: body.caseId,
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
    await TerminalWorkspaceSvc.assertCan("change", id, userId);
    const data: { name?: string; preset?: WorkspacePreset; layoutJson?: Prisma.InputJsonValue } = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.preset !== undefined) data.preset = body.preset;
    if (body.layoutJson !== undefined) data.layoutJson = normalizeLayout(body.layoutJson, sku) as unknown as Prisma.InputJsonValue;
    // isLastUsed is the caller's own pick, not part of the shared layout. Only setting it means
    // anything: the last-used tab is replaced by choosing another, never cleared.
    const updated = await TerminalWorkspaceRepo.update(id, userId, data);
    if (body.isLastUsed) await TerminalWorkspaceRepo.markLastUsed(id, userId);
    return TerminalWorkspaceSvc.clean(body.isLastUsed ? { ...updated, isLastUsed: true } : updated);
  }

  /** Picking a tab only changes the caller's own last-used layout, so viewing the case is enough. */
  static async apply(id: string, userId: string) {
    await TerminalWorkspaceSvc.assertCan("view", id, userId);
    const updated = await TerminalWorkspaceRepo.markLastUsed(id, userId);
    if (!updated) throw new HttpError("Workspace not found", 404);
    return TerminalWorkspaceSvc.clean(updated);
  }

  static async resetToPreset(userId: string, sku: string, caseId: string, preset?: WorkspacePreset) {
    await CaseAccess.assertCanContribute(caseId, userId);
    const resolved = preset ?? defaultPresetForSku(sku);
    return TerminalWorkspaceRepo.create(userId, {
      caseId,
      name: `Default ${resolved.replace("_", " ")}`,
      preset: resolved,
      layoutJson: buildDefaultLayout(resolved, sku) as unknown as Prisma.InputJsonValue,
    });
  }

  static async delete(id: string, userId: string) {
    await TerminalWorkspaceSvc.assertCan("change", id, userId);
    const deleted = await TerminalWorkspaceRepo.delete(id);
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
