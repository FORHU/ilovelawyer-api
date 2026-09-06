import { expect } from "chai";
import { describe, it } from "mocha";
import { isMindMapStale } from "../src/utils/mind-map-staleness";

describe("isMindMapStale", () => {
  it("is false when no mind map has ever been generated", () => {
    expect(isMindMapStale(null, new Date("2026-01-02"))).to.equal(false);
  });

  it("is false when there is no case activity at all", () => {
    expect(isMindMapStale(new Date("2026-01-01"), null)).to.equal(false);
  });

  it("is true when case activity is newer than the last generation", () => {
    expect(isMindMapStale(new Date("2026-01-01"), new Date("2026-01-02"))).to.equal(true);
  });

  it("is false when the last generation is newer than any activity", () => {
    expect(isMindMapStale(new Date("2026-01-02"), new Date("2026-01-01"))).to.equal(false);
  });

  it("is false when generation and activity are exactly simultaneous", () => {
    const t = new Date("2026-01-01T00:00:00.000Z");
    expect(isMindMapStale(t, t)).to.equal(false);
  });
});
