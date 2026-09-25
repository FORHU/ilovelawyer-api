import { expect } from "chai";
import { describe, it } from "mocha";
import { buildCaseTrends, weeklyTrend } from "../src/utils/case-trends";

// Thursday — its week starts Monday 2026-09-21.
const NOW = new Date("2026-09-24T10:00:00Z");

describe("weeklyTrend", () => {
  it("returns one Monday-aligned bucket per week, oldest first", () => {
    const points = weeklyTrend([], 3, NOW);
    expect(points.map((p) => p.weekStart)).to.deep.equal([
      "2026-09-07T00:00:00.000Z",
      "2026-09-14T00:00:00.000Z",
      "2026-09-21T00:00:00.000Z",
    ]);
  });

  it("counts items before the window in the running total, not in any bucket's added", () => {
    const dates = [new Date("2026-08-01"), new Date("2026-09-15"), new Date("2026-09-23")];
    expect(weeklyTrend(dates, 3, NOW)).to.deep.equal([
      { weekStart: "2026-09-07T00:00:00.000Z", added: 0, total: 1 },
      { weekStart: "2026-09-14T00:00:00.000Z", added: 1, total: 2 },
      { weekStart: "2026-09-21T00:00:00.000Z", added: 1, total: 3 },
    ]);
  });

  it("puts an item created at Monday 00:00 in that Monday's bucket", () => {
    const points = weeklyTrend([new Date("2026-09-21T00:00:00Z")], 2, NOW);
    expect(points.map((p) => p.added)).to.deep.equal([0, 1]);
  });
});

describe("buildCaseTrends", () => {
  it("counts only currently OPEN risks as open issues, and every document as evidence", () => {
    const trends = buildCaseTrends({
      risks: [
        { createdAt: new Date("2026-09-22"), status: "OPEN" },
        { createdAt: new Date("2026-09-22"), status: "ACCEPTED" },
      ],
      documents: [{ createdAt: new Date("2026-09-22") }, { createdAt: new Date("2026-09-15") }],
      weeks: 2,
      now: NOW,
    });
    expect(trends.openIssues.map((p) => p.total)).to.deep.equal([0, 1]);
    expect(trends.evidence.map((p) => p.total)).to.deep.equal([1, 2]);
  });
});
