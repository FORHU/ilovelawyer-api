import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { dropUnknownPanelsFromLayout, regroupLayoutOnce, tabsToColumns } from "../src/utils/terminal-layout";
import TerminalWorkspaceSvc from "../src/services/terminal-workspace.service";
import TerminalWorkspaceRepo from "../src/repositories/terminal-workspace.repository";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

// ADR 0016 retired these four panes. normalizeLayout only runs when a workspace is SAVED, so a workspace saved before then is
// returned with the old ids, and the Terminal crashed rendering one that was visible ("undefined is not iterable" in PaneCode).
const RETIRED = ["contradictions", "citationMap", "teamAudit", "verification"];

const panel = (id: string, visible = true, order = 0, extra: Record<string, unknown> = {}) => ({ id, visible, order, width: 1, height: 1, ...extra });
const ids = (layout: unknown) => ((layout as { panels: { id: string }[] }).panels ?? []).map((p) => p.id);

describe("dropUnknownPanelsFromLayout", () => {
  it("drops the retired panes and keeps the rest in order", () => {
    const layout = { preset: "PANE_4", panels: [panel("command", true, 0), panel("contradictions", true, 1), panel("evidence", true, 2), panel("verification", false, 3)] };
    expect(ids(dropUnknownPanelsFromLayout(layout))).to.deep.equal(["command", "evidence"]);
  });

  it("covers all four retired panes", () => {
    const layout = { panels: [panel("command"), ...RETIRED.map((id, i) => panel(id, true, i + 1))] };
    expect(ids(dropUnknownPanelsFromLayout(layout))).to.deep.equal(["command"]);
  });

  it("returns the very same object when there is nothing to drop", () => {
    const layout = { panels: [panel("command"), panel("evidence")] };
    expect(dropUnknownPanelsFromLayout(layout)).to.equal(layout);
  });

  it("keeps everything else about the layout exactly as it was", () => {
    const layout = {
      preset: "PANE_6",
      arrangement: "columns",
      columnCount: 3,
      columnWidths: [0.2, 0.5, 0.3],
      panels: [panel("command", true, 0, { columnIndex: 1, pinned: true, screen: 2, x: 0.25, y: 0.5 }), panel("contradictions", true, 1)],
    };
    const out = dropUnknownPanelsFromLayout(layout) as typeof layout;
    expect(out.arrangement).to.equal("columns");
    expect(out.columnCount).to.equal(3);
    expect(out.columnWidths).to.deep.equal([0.2, 0.5, 0.3]);
    expect(out.panels[0]).to.deep.equal(layout.panels[0]);
  });

  it("shows the Command pane when dropping leaves nothing visible", () => {
    const layout = { panels: [panel("command", false, 5), panel("contradictions", true, 0), panel("citationMap", true, 1)] };
    const command = (dropUnknownPanelsFromLayout(layout) as any).panels.find((p: any) => p.id === "command");
    expect(command).to.deep.include({ visible: true, order: 0, width: 1, height: 1 });
  });

  it("does not touch visibility when a visible pane survives", () => {
    const layout = { panels: [panel("command", false, 0), panel("evidence", true, 1), panel("teamAudit", true, 2)] };
    expect((dropUnknownPanelsFromLayout(layout) as any).panels.find((p: any) => p.id === "command").visible).to.equal(false);
  });

  it("returns anything that is not a layout untouched", () => {
    for (const value of [null, undefined, "x", 3, [], {}, { panels: "nope" }]) {
      expect(dropUnknownPanelsFromLayout(value)).to.equal(value);
    }
  });

  it("does not mutate its input", () => {
    const layout = { panels: [panel("command"), panel("contradictions")] };
    const before = JSON.stringify(layout);
    dropUnknownPanelsFromLayout(layout);
    expect(JSON.stringify(layout)).to.equal(before);
  });
});

const originalRepo = {
  list: TerminalWorkspaceRepo.list,
  findRow: TerminalWorkspaceRepo.findRow,
  findById: TerminalWorkspaceRepo.findById,
  markLastUsed: TerminalWorkspaceRepo.markLastUsed,
  update: TerminalWorkspaceRepo.update,
  delete: TerminalWorkspaceRepo.delete,
};
const originalAccess = { loadAccessibleCase: CaseAccess.loadAccessibleCase, assertCanContribute: CaseAccess.assertCanContribute };
const restore = () => {
  Object.assign(TerminalWorkspaceRepo, originalRepo);
  Object.assign(CaseAccess, originalAccess);
};

describe("TerminalWorkspaceSvc returns cleaned layouts", () => {
  beforeEach(() => {
    (CaseAccess as any).loadAccessibleCase = async () => ({});
    (CaseAccess as any).assertCanContribute = async () => ({});
    (TerminalWorkspaceRepo as any).findRow = async () => ({ id: "w1", caseId: "c1", userId: "u1" });
  });
  afterEach(restore);

  const stale = () => ({ id: "w1", name: "Mine", isLastUsed: true, layoutJson: { panels: [panel("command"), panel("contradictions", true, 1)] } });
  const stub = (method: keyof typeof originalRepo, value: unknown) => ((TerminalWorkspaceRepo as any)[method] = async () => value);

  it("list", async () => {
    stub("list", [stale()]);
    const rows = await TerminalWorkspaceSvc.list("u1", "c1");
    expect(ids(rows[0].layoutJson)).to.deep.equal(["command"]);
  });

  it("getById", async () => {
    stub("findById", stale());
    expect(ids((await TerminalWorkspaceSvc.getById("w1", "u1")).layoutJson)).to.deep.equal(["command"]);
  });

  it("apply", async () => {
    stub("markLastUsed", stale());
    expect(ids((await TerminalWorkspaceSvc.apply("w1", "u1")).layoutJson)).to.deep.equal(["command"]);
  });

  it("update that does not send a layout (a rename) still returns a cleaned one", async () => {
    stub("update", stale());
    const row = await TerminalWorkspaceSvc.update("w1", "u1", "SOLO", { name: "Renamed" });
    expect(ids(row.layoutJson)).to.deep.equal(["command"]);
  });

  it("a row with a clean layout comes back unchanged", async () => {
    const clean = { id: "w2", layoutJson: { layoutVersion: 1, panels: [panel("command"), panel("evidence")] } };
    stub("findById", clean);
    expect(await TerminalWorkspaceSvc.getById("w2", "u1")).to.equal(clean);
  });
});

describe("tabsToColumns", () => {
  it("turns Tabs screens into 2 Columns, top level and per screen, and drops the Tabs fields", () => {
    const layout = {
      arrangement: "tabs",
      tabsSplit: 0.3,
      tabsActiveA: "command",
      panels: [panel("command", true, 0, { tabGroup: 0 }), panel("law", true, 1, { tabGroup: 1, screen: 1 }), panel("evidence", true, 2, { screen: 1 })],
      screenLayouts: { 1: { arrangement: "tabs", tabsActiveB: "law" } },
    };
    const out = tabsToColumns(layout) as any;
    expect(out).to.deep.include({ arrangement: "columns", columnCount: 2 });
    expect(out.columnWidths).to.deep.equal([0.3, 0.7]);
    expect(out.screenLayouts[1]).to.deep.equal({ arrangement: "columns", columnCount: 2, columnWidths: [0.5, 0.5] });
    expect(out.panels.map((p: any) => p.columnIndex)).to.deep.equal([0, 1, 0]);
    expect(JSON.stringify(out)).to.not.contain("tab");
  });

  it("returns the same object when there is nothing Tabs-related, and non-layouts untouched", () => {
    const layout = { arrangement: "columns", panels: [panel("command")] };
    expect(tabsToColumns(layout)).to.equal(layout);
    expect(tabsToColumns(null)).to.equal(null);
  });
});

describe("regroupLayoutOnce", () => {
  const cols = (layout: any) => Object.fromEntries(layout.panels.filter((p: any) => p.visible).map((p: any) => [p.id, p.columnIndex]));

  it("puts related panes in the same column, once, and stamps the version", () => {
    const layout = {
      arrangement: "columns",
      columnCount: 2,
      panels: [panel("chat", true, 0), panel("weaknesses", true, 1), panel("command", true, 2), panel("strengths", true, 3)],
    };
    const out = regroupLayoutOnce(layout) as any;
    const c = cols(out);
    expect(c.strengths).to.equal(c.weaknesses);
    expect(c.command).to.not.equal(c.strengths);
    expect(out.layoutVersion).to.equal(1);
    expect(regroupLayoutOnce(out)).to.equal(out);
  });

  it("leaves pinned panes, Free layouts and non-layouts alone", () => {
    const pinned = { arrangement: "columns", columnCount: 2, panels: [panel("chat", true, 0, { pinned: true, columnIndex: 0 }), panel("command", true, 1)] };
    expect((regroupLayoutOnce(pinned) as any).panels[0]).to.deep.equal(pinned.panels[0]);
    const free = { arrangement: "free", panels: [panel("chat", true, 0, { x: 0.5, y: 0.5 }), panel("command", true, 1, { x: 0, y: 0 })] };
    expect((regroupLayoutOnce(free) as any).panels).to.deep.equal(free.panels);
    expect(regroupLayoutOnce(null)).to.equal(null);
  });
});

// Layouts are shared by everyone on the case (a member's rename is what the others see), so access
// follows the case rather than who created the layout.
describe("TerminalWorkspaceSvc reaches layouts through their case", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    (CaseAccess as any).loadAccessibleCase = async (caseId: string, userId: string) => calls.push(`view ${caseId} ${userId}`);
    (CaseAccess as any).assertCanContribute = async (caseId: string, userId: string) => calls.push(`change ${caseId} ${userId}`);
    (TerminalWorkspaceRepo as any).findRow = async () => ({ id: "w1", caseId: "c1", userId: "creator" });
    (TerminalWorkspaceRepo as any).list = async () => [];
    (TerminalWorkspaceRepo as any).update = async () => ({ id: "w1", layoutJson: { layoutVersion: 1, panels: [] } });
    (TerminalWorkspaceRepo as any).markLastUsed = async () => ({ id: "w1", layoutJson: { layoutVersion: 1, panels: [] } });
    (TerminalWorkspaceRepo as any).delete = async () => true;
  });
  afterEach(restore);

  it("lists a case's layouts for anyone who can open it", async () => {
    await TerminalWorkspaceSvc.list("member", "c1");
    expect(calls).to.deep.equal(["view c1 member"]);
  });

  it("lets another member rename a layout they didn't create, if they can contribute to the case", async () => {
    await TerminalWorkspaceSvc.update("w1", "member", "SOLO", { name: "TEST" });
    expect(calls).to.deep.equal(["change c1 member"]);
  });

  it("only needs view access to pick a tab", async () => {
    await TerminalWorkspaceSvc.apply("w1", "member");
    expect(calls).to.deep.equal(["view c1 member"]);
  });

  it("needs contribute access to delete", async () => {
    await TerminalWorkspaceSvc.delete("w1", "member");
    expect(calls).to.deep.equal(["change c1 member"]);
  });

  it("refuses a change from someone the case refuses", async () => {
    (CaseAccess as any).assertCanContribute = async () => {
      throw new HttpError("You have view-only access to this confidential case", 403);
    };
    let updated = false;
    (TerminalWorkspaceRepo as any).update = async () => ((updated = true), { id: "w1", layoutJson: {} });
    try {
      await TerminalWorkspaceSvc.update("w1", "viewer", "SOLO", { name: "TEST" });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as HttpError).statusCode).to.equal(403);
    }
    expect(updated).to.equal(false);
  });

  it("keeps a layout saved before case-scoping to its creator", async () => {
    (TerminalWorkspaceRepo as any).findRow = async () => ({ id: "w1", caseId: null, userId: "creator" });
    try {
      await TerminalWorkspaceSvc.update("w1", "someone-else", "SOLO", { name: "TEST" });
      expect.fail("should have thrown");
    } catch (error) {
      expect((error as HttpError).statusCode).to.equal(404);
    }
    await TerminalWorkspaceSvc.update("w1", "creator", "SOLO", { name: "TEST" });
    expect(calls).to.deep.equal([]);
  });
});
