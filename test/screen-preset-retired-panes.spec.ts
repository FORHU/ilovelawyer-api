import { expect } from "chai";
import { describe, it } from "mocha";
import { dropUnknownPanelIds, normalizeScreenPresetScreens } from "../src/utils/screen-preset";

describe("dropUnknownPanelIds", () => {
  it("takes retired panes out of a stored preset, keeping every screen", () => {
    expect(
      dropUnknownPanelIds([
        { arrangement: "free", panelIds: ["command", "contradictions"] },
        { arrangement: "columns", panelIds: ["teamAudit", "verification"] },
      ]),
    ).to.deep.equal([
      { arrangement: "free", panelIds: ["command"] },
      { arrangement: "columns", panelIds: [] },
    ]);
  });

  it("opens a stored Tabs preset screen as Columns", () => {
    expect(dropUnknownPanelIds([{ arrangement: "tabs", panelIds: ["command"] }])).to.deep.equal([{ arrangement: "columns", panelIds: ["command"] }]);
  });

  it("leaves anything that isn't a list of screens alone", () => {
    expect(dropUnknownPanelIds(null)).to.equal(null);
    expect(dropUnknownPanelIds([{ arrangement: "free" }])).to.deep.equal([{ arrangement: "free" }]);
  });
});

describe("normalizeScreenPresetScreens columns", () => {
  it("keeps explicit columns on a Columns screen, drops empty ones and derives panelIds", () => {
    const { screens } = normalizeScreenPresetScreens(
      [{ arrangement: "columns", panelIds: [], columns: [["command", "evidence"], [], ["witnesses", "nope"]] }],
      "ENTERPRISE",
    );
    expect(screens[0]).to.deep.equal({ arrangement: "columns", panelIds: ["command", "evidence", "witnesses"], columns: [["command", "evidence"], ["witnesses"]] });
  });

  it("ignores columns on a non-Columns screen", () => {
    const { screens } = normalizeScreenPresetScreens([{ arrangement: "free", panelIds: ["command"], columns: [["evidence"]] }], "ENTERPRISE");
    expect(screens[0]).to.deep.equal({ arrangement: "free", panelIds: ["command"] });
  });
});
