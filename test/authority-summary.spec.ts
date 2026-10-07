import { expect } from "chai";
import { describe, it } from "mocha";
import { summarizeAuthorities } from "../src/utils/authority-summary";

describe("summarizeAuthorities", () => {
  const grounds = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];

  it("counts each stance and reports per-ground coverage", () => {
    const summary = summarizeAuthorities(
      [
        { stance: "STATUTE", findingId: "g1" },
        { stance: "ON_POINT", findingId: "g2" },
        { stance: "ON_POINT", findingId: "g2" },
        { stance: "ADVERSE", findingId: "g2" },
      ],
      grounds,
    );
    expect(summary).to.deep.equal({
      statute: 1,
      onPoint: 2,
      adverse: 1,
      total: 4,
      groundsTotal: 3,
      groundsSupported: 2,
      groundsContested: 1,
      unlinked: 0,
      coverage: 2 / 3,
    });
  });

  it("has no coverage when the case has no grounds", () => {
    expect(summarizeAuthorities([], []).coverage).to.equal(null);
  });

  it("does not count a ground supported by adverse authority alone, or untied authority", () => {
    const s = summarizeAuthorities(
      [
        { stance: "ADVERSE", findingId: "g1" },
        { stance: "ON_POINT", findingId: null },
      ],
      grounds,
    );
    expect(s.groundsSupported).to.equal(0);
    expect(s.groundsContested).to.equal(1);
    expect(s.unlinked).to.equal(1);
    expect(s.coverage).to.equal(0);
  });
});
