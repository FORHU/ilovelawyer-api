import { expect } from "chai";
import { describe, it } from "mocha";
import { strategyStaleness } from "../src/utils/strategy-staleness";

const at = (min: number) => new Date(Date.UTC(2026, 8, 28, 10, min));

describe("strategyStaleness", () => {
  it("is never stale before the first generation", () => {
    expect(strategyStaleness([{ action: "document.ready", createdAt: at(5) }])).to.deep.equal({ lastGeneratedAt: null, isStale: false, changedSince: 0 });
  });

  it("goes stale when a document is added after the last generation, and counts the changes", () => {
    const result = strategyStaleness([
      { action: "document.ready", createdAt: at(9) },
      { action: "finding.create", createdAt: at(8) },
      { action: "strategy.generate", createdAt: at(1) },
    ]);
    expect(result.isStale).to.equal(true);
    expect(result.changedSince).to.equal(2);
    expect(result.lastGeneratedAt).to.deep.equal(at(1));
  });

  it("ignores the panel's own edits, so ticking a to-do doesn't make it stale", () => {
    const result = strategyStaleness([
      { action: "deadline.recompute", createdAt: at(9) },
      { action: "risk.create", createdAt: at(8) },
      { action: "mindMap.build", createdAt: at(7) },
      { action: "strategy.generate", createdAt: at(1) },
    ]);
    expect(result.isStale).to.equal(false);
  });

  it("clears once regenerated", () => {
    const result = strategyStaleness([
      { action: "strategy.generate", createdAt: at(20) },
      { action: "document.ready", createdAt: at(9) },
      { action: "strategy.generate", createdAt: at(1) },
    ]);
    expect(result.isStale).to.equal(false);
  });
});
