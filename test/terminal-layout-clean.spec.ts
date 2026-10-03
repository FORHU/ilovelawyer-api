import { expect } from "chai";
import { afterEach, describe, it } from "mocha";
import { dropUnknownPanelsFromLayout } from "../src/utils/terminal-layout";
import TerminalWorkspaceSvc from "../src/services/terminal-workspace.service";
import TerminalWorkspaceRepo from "../src/repositories/terminal-workspace.repository";

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
      tabsSplit: 0.4,
      panels: [panel("command", true, 0, { columnIndex: 1, pinned: true, screen: 2, x: 0.25, y: 0.5 }), panel("contradictions", true, 1)],
    };
    const out = dropUnknownPanelsFromLayout(layout) as typeof layout;
    expect(out.arrangement).to.equal("columns");
    expect(out.columnCount).to.equal(3);
    expect(out.columnWidths).to.deep.equal([0.2, 0.5, 0.3]);
    expect(out.tabsSplit).to.equal(0.4);
    expect(out.panels[0]).to.deep.equal(layout.panels[0]);
  });

  it("clears a tab that pointed at a dropped pane, at the top level and per screen", () => {
    const layout = {
      panels: [panel("command"), panel("evidence")],
      tabsActiveA: "contradictions",
      tabsActiveB: "evidence",
      screenLayouts: { 1: { tabsActiveA: "verification", tabsActiveB: "command" } },
    };
    const out = dropUnknownPanelsFromLayout(layout) as any;
    expect(out.tabsActiveA).to.equal(undefined);
    expect(out.tabsActiveB).to.equal("evidence");
    expect(out.screenLayouts[1].tabsActiveA).to.equal(undefined);
    expect(out.screenLayouts[1].tabsActiveB).to.equal("command");
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
    const layout = { panels: [panel("command"), panel("contradictions")], tabsActiveA: "verification" };
    const before = JSON.stringify(layout);
    dropUnknownPanelsFromLayout(layout);
    expect(JSON.stringify(layout)).to.equal(before);
  });
});

describe("TerminalWorkspaceSvc returns cleaned layouts", () => {
  const original = {
    list: TerminalWorkspaceRepo.list,
    findById: TerminalWorkspaceRepo.findById,
    markLastUsed: TerminalWorkspaceRepo.markLastUsed,
    update: TerminalWorkspaceRepo.update,
  };
  afterEach(() => Object.assign(TerminalWorkspaceRepo, original));

  const stale = () => ({ id: "w1", name: "Mine", isLastUsed: true, layoutJson: { panels: [panel("command"), panel("contradictions", true, 1)] } });
  const stub = (method: keyof typeof original, value: unknown) => ((TerminalWorkspaceRepo as any)[method] = async () => value);

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
    const clean = { id: "w2", layoutJson: { panels: [panel("command"), panel("evidence")] } };
    stub("findById", clean);
    expect(await TerminalWorkspaceSvc.getById("w2", "u1")).to.equal(clean);
  });
});
