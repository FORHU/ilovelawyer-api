import { expect } from "chai";
import { describe, it } from "mocha";
import { dropUnknownPanelIds } from "../src/utils/screen-preset";

describe("dropUnknownPanelIds", () => {
  it("takes retired panes out of a stored preset, keeping every screen", () => {
    expect(
      dropUnknownPanelIds([
        { arrangement: "free", panelIds: ["command", "contradictions"] },
        { arrangement: "tabs", panelIds: ["teamAudit", "verification"] },
      ]),
    ).to.deep.equal([
      { arrangement: "free", panelIds: ["command"] },
      { arrangement: "tabs", panelIds: [] },
    ]);
  });

  it("leaves anything that isn't a list of screens alone", () => {
    expect(dropUnknownPanelIds(null)).to.equal(null);
    expect(dropUnknownPanelIds([{ arrangement: "free" }])).to.deep.equal([{ arrangement: "free" }]);
  });
});
