import { expect } from "chai";
import { describe, it } from "mocha";
import { summarizeAuthorities } from "../src/utils/authority-summary";

describe("summarizeAuthorities", () => {
  it("counts each stance and reports on-point coverage", () => {
    const summary = summarizeAuthorities([
      { stance: "STATUTE" },
      { stance: "ON_POINT" },
      { stance: "ON_POINT" },
      { stance: "ADVERSE" },
    ]);
    expect(summary).to.deep.equal({ statute: 1, onPoint: 2, adverse: 1, total: 4, coverage: 0.5 });
  });

  it("has no coverage when nothing is cited", () => {
    expect(summarizeAuthorities([]).coverage).to.equal(null);
  });
});
