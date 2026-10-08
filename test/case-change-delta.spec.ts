/** The analysis refresh's change summary: the pure before/after comparisons behind each pane's
 * entry (utils/case-change-delta.ts) and the headline count. No DB — plain rows in, deltas out. */
import { expect } from "chai";
import { describe, it } from "mocha";
import {
  audioOverviewDelta,
  countChanges,
  diffContradictions,
  diffDamages,
  diffFindings,
  diffMindMap,
  diffOutlook,
  diffReconstruction,
  diffRedTeam,
  diffStrategy,
  diffTheory,
  diffWitnesses,
} from "../src/utils/case-change-delta";
import { CASE_CHANGE_MAX_LISTED } from "../src/constants";

const docName = new Map([
  ["d1", "Termination letter"],
  ["d2", "Payroll"],
]);
const contradiction = (over: object = {}) => ({
  kind: "DATE",
  factKey: "incident_date",
  leftDocumentId: "d1",
  rightDocumentId: "d2",
  leftValue: "4 August 2024",
  rightValue: "8 August 2024",
  status: "OPEN",
  ...over,
});

describe("diffContradictions", () => {
  it("names what the scan found new and what it no longer finds, and counts the rest as carried over", () => {
    const previous = [contradiction(), contradiction({ factKey: "salary", leftValue: "₱30,000", rightValue: "₱35,000", status: "RESOLVED" })];
    // Same conflict with its sides swapped and different spacing: still the same contradiction.
    const next = [
      contradiction({ leftDocumentId: "d2", rightDocumentId: "d1", leftValue: "8  August 2024", rightValue: "4 August 2024" }),
      contradiction({ factKey: "contract_date", leftValue: "1 Jan", rightValue: "3 Jan" }),
    ];
    const delta = diffContradictions(previous, next, docName);
    expect(delta).to.include({ status: "changed", addedCount: 1, droppedCount: 1, carriedOver: 1, droppedTriaged: 1 });
    expect(delta.added[0]).to.deep.equal({
      kind: "DATE",
      factKey: "contract_date",
      leftValue: "1 Jan",
      rightValue: "3 Jan",
      leftDocument: "Termination letter",
      rightDocument: "Payroll",
    });
    expect(delta.dropped[0].factKey).to.equal("salary");
  });

  it("is unchanged when the rescan finds exactly the same contradictions", () => {
    expect(diffContradictions([contradiction()], [contradiction()], docName)).to.include({ status: "unchanged", carriedOver: 1 });
  });

  it("caps the names it lists but keeps the counts exact", () => {
    const next = Array.from({ length: CASE_CHANGE_MAX_LISTED + 5 }, (_, i) => contradiction({ factKey: `f${i}` }));
    const delta = diffContradictions([], next, docName);
    expect(delta.added).to.have.length(CASE_CHANGE_MAX_LISTED);
    expect(delta.addedCount).to.equal(CASE_CHANGE_MAX_LISTED + 5);
  });
});

describe("diffFindings", () => {
  const finding = (label: string, over: object = {}) => ({ category: "WEAKNESS" as const, label, tag: null, impact: null, ...over });

  it("groups added, removed and re-rated findings by category, matching labels case- and space-insensitively", () => {
    const before = [finding("No signed contract", { tag: "MINOR" }), finding("Late payslips"), finding("Clear dismissal letter", { category: "STRENGTH" })];
    const after = [finding("no signed contract ", { tag: "MATERIAL" }), finding("Gap in overtime records"), finding("Clear dismissal letter", { category: "STRENGTH" })];
    const delta = diffFindings(before, after);
    expect(delta.status).to.equal("changed");
    expect(delta.byCategory).to.have.keys("WEAKNESS");
    expect(delta.byCategory.WEAKNESS).to.deep.equal({
      added: ["Gap in overtime records"],
      removed: ["Late payslips"],
      rerated: [{ label: "no signed contract ", from: { tag: "MINOR", impact: null }, to: { tag: "MATERIAL", impact: null } }],
    });
  });

  it("records the one category a panel's own Regenerate rewrote", () => {
    expect(diffFindings([], [finding("A")], "WEAKNESS").category).to.equal("WEAKNESS");
    expect(diffFindings([], [finding("A")])).not.to.have.property("category");
  });

  it("is unchanged when the same findings come back with the same ratings", () => {
    const rows = [finding("No signed contract", { impact: 4 })];
    expect(diffFindings(rows, [...rows])).to.deep.equal({ status: "unchanged", byCategory: {} });
  });
});

describe("diffRedTeam", () => {
  const assessment = (riskOfLoss: number | null, args: [string, string][]) => ({
    arguments: { opponent: "Northgate", riskOfLoss, arguments: args.map(([title, strength]) => ({ title, strength })) },
  });

  it("names new, dropped and re-strengthened arguments and the risk-of-loss move", () => {
    const before = assessment(38, [["Abandonment of work", "MODERATE"], ["Late filing", "WEAK"]]);
    const after = assessment(47, [["Abandonment  of work", "STRONG"], ["Unpaid overtime was waived", "MODERATE"]]);
    const delta = diffRedTeam(before, after);
    expect(delta).to.deep.include({
      status: "changed",
      first: false,
      riskOfLoss: { from: 38, to: 47 },
      added: ["Unpaid overtime was waived"],
      dropped: ["Late filing"],
      restrengthened: [{ title: "Abandonment  of work", from: "MODERATE", to: "STRONG" }],
    });
    // 1 added + 1 dropped + 1 re-strengthened + the 9-point risk move.
    expect(countChanges({ redTeam: delta })).to.equal(4);
  });

  it("doesn't count a small risk-of-loss wobble", () => {
    const delta = diffRedTeam(assessment(40, [["A", "WEAK"]]), assessment(43, [["A", "WEAK"]]));
    expect(delta.status).to.equal("unchanged");
  });

  it("treats the first assessment (or one from before ranked arguments) as nothing to compare", () => {
    expect(diffRedTeam(null, assessment(40, [["A", "WEAK"]]))).to.include({ status: "unchanged", first: true });
    expect(diffRedTeam({ arguments: null }, assessment(40, [["A", "WEAK"]]))).to.include({ status: "unchanged", first: true });
  });
});

describe("diffReconstruction", () => {
  const row = (gaps: string[], claims: { category: string }[] = []) => ({ gaps, claims });

  it("names gaps opened and closed, and counts attribution on both sides", () => {
    const delta = diffReconstruction(
      row(["Who signed the memo is unknown", "No payroll for March"], [{ category: "GROUNDED" }, { category: "INFERENCE" }]),
      row(["No payroll for March", "Why the gate log stops at 18:02"], [{ category: "GROUNDED" }, { category: "GROUNDED" }]),
      "regenerated",
    );
    expect(delta).to.deep.include({
      status: "changed",
      gapsOpened: ["Why the gate log stops at 18:02"],
      gapsClosed: ["Who signed the memo is unknown"],
      attribution: { from: { GROUNDED: 1, INFERENCE: 1, UNSUPPORTED: 0 }, to: { GROUNDED: 2, INFERENCE: 0, UNSUPPORTED: 0 } },
    });
  });

  it("doesn't count a rewritten narrative whose gaps stayed the same", () => {
    expect(diffReconstruction(row(["A"]), row(["a "]), "regenerated").status).to.equal("unchanged");
  });

  it("opens no gaps on a first narrative, and is skipped when the lawyer's edit was protected", () => {
    expect(diffReconstruction(null, row(["A"]), "generated")).to.include({ status: "unchanged" }).and.deep.include({ gapsOpened: [] });
    expect(diffReconstruction(row(["A"]), row(["A"]), "skipped-edited").status).to.equal("skipped");
  });
});

describe("diffOutlook", () => {
  const outlook = (id: string, band: string, drivers: { label: string; direction: string }[] = [], confidence = "MEDIUM") =>
    ({ id, band, confidence, drivers }) as any;

  it("names the band move and the drivers added or dropped", () => {
    const delta = diffOutlook(
      outlook("o1", "LEANS_FAVORABLE", [{ label: "Signed termination letter", direction: "HELPS" }]),
      outlook("o2", "UNCERTAIN", [{ label: "Payroll contradicts the dismissal date", direction: "HURTS" }]),
    );
    expect(delta).to.deep.include({
      status: "changed",
      band: { from: "LEANS_FAVORABLE", to: "UNCERTAIN" },
      driversAdded: [{ label: "Payroll contradicts the dismissal date", direction: "HURTS" }],
      driversDropped: [{ label: "Signed termination letter", direction: "HELPS" }],
    });
    expect(countChanges({ outlook: delta })).to.equal(3);
  });

  it("is unchanged when the step kept the previous outlook (same row)", () => {
    const row = outlook("o1", "UNCERTAIN");
    expect(diffOutlook(row, row).status).to.equal("unchanged");
  });

  it("shows a confidence change without counting it", () => {
    const delta = diffOutlook(outlook("o1", "UNCERTAIN", [], "HIGH"), outlook("o2", "UNCERTAIN", [], "LOW"));
    expect(delta.confidence).to.deep.equal({ from: "HIGH", to: "LOW" });
    expect(delta.status).to.equal("unchanged");
  });
});

describe("diffStrategy", () => {
  it("names plan items, to-dos and key dates added or removed", () => {
    const before = {
      items: [{ kind: "STRATEGY", label: "Argue constructive dismissal" }, { kind: "TODO", label: "Request CCTV" }],
      dates: [{ title: "Dismissal letter served", occurredOn: new Date("2024-08-04") }],
    };
    const after = {
      items: [{ kind: "STRATEGY", label: "argue constructive dismissal" }, { kind: "TODO", label: "Request payroll records" }],
      dates: [
        { title: "Dismissal letter served", occurredOn: new Date("2024-08-04") },
        { title: "Last salary paid", occurredOn: new Date("2024-08-08") },
      ],
    };
    const delta = diffStrategy(before, after);
    expect(delta).to.deep.equal({
      status: "changed",
      planAdded: [],
      planRemoved: [],
      todosAdded: ["Request payroll records"],
      todosRemoved: ["Request CCTV"],
      datesAdded: [{ title: "Last salary paid", occurredOn: "2024-08-08" }],
      datesRemoved: [],
    });
    expect(countChanges({ strategy: delta })).to.equal(3);
  });
});

describe("diffWitnesses", () => {
  it("names new and removed witnesses and a shown score that moved 10 points or more", () => {
    const delta = diffWitnesses(
      [
        { name: "J. Cruz", credibility: 50, aiCredibility: 70 },
        { name: "A. Santos", credibility: 50, aiCredibility: 60 },
        { name: "L. Tan", credibility: 50 },
      ],
      [
        { name: "J. Cruz", credibility: 50, aiCredibility: 45 },
        // A lawyer's override is what the pane shows, so the AI's move doesn't count.
        { name: "A. Santos", credibility: 50, aiCredibility: 20, credibilityOverride: 60 },
        { name: "M. Reyes", credibility: 50 },
      ],
    );
    expect(delta).to.deep.equal({ status: "changed", added: ["M. Reyes"], removed: ["L. Tan"], rescored: [{ name: "J. Cruz", from: 70, to: 45 }] });
  });

  it("doesn't count a small re-score", () => {
    expect(diffWitnesses([{ name: "J. Cruz", credibility: 50, aiCredibility: 70 }], [{ name: "J. Cruz", credibility: 50, aiCredibility: 64 }]).status).to.equal("unchanged");
  });
});

describe("diffDamages", () => {
  it("names entries added or removed and amounts that changed", () => {
    const delta = diffDamages(
      [{ kind: "DAMAGE", title: "Unpaid overtime", amount: 30000 }, { kind: "REMEDY", title: "Reinstatement", amount: null }],
      [{ kind: "DAMAGE", title: "Unpaid overtime", amount: 42000 }, { kind: "DAMAGE", title: "13th month pay", amount: 25000 }],
    );
    expect(delta).to.deep.equal({
      status: "changed",
      added: ["13th month pay"],
      removed: ["Reinstatement"],
      amountChanged: [{ title: "Unpaid overtime", from: 30000, to: 42000 }],
    });
  });
});

describe("diffTheory", () => {
  const theory = (title: string, claims: [string, string][], assumptions: string[] = [], questions: string[] = []) => ({
    title,
    claims: claims.map(([statement, stance]) => ({ statement, stance })),
    assumptions: assumptions.map((statement) => ({ statement })),
    openQuestions: questions.map((question) => ({ question })),
  });

  it("names the title change and claims added or dropped, and counts assumptions and questions without scoring them", () => {
    const delta = diffTheory(
      theory("Unpaid overtime", [["Overtime was ordered", "ASSERTS"]], ["Logs are complete"]),
      theory("Constructive dismissal", [["Overtime was ordered", "ASSERTS"], ["The employee resigned freely", "DENIES"]], [], ["Who approved the shifts?"]),
    );
    expect(delta).to.deep.include({
      status: "changed",
      title: { from: "Unpaid overtime", to: "Constructive dismissal" },
      claimsAdded: ["The employee resigned freely"],
      claimsDropped: [],
      assumptionsChanged: 1,
      openQuestionsChanged: 1,
    });
    expect(countChanges({ theory: delta })).to.equal(2);
  });

  it("has nothing to compare for the first AI draft", () => {
    expect(diffTheory(null, theory("A", [["B", "ASSERTS"]]))).to.include({ status: "unchanged", first: true });
  });
});

describe("diffMindMap", () => {
  const node = (label: string, children: any[] = []) => ({ id: label, label, children });

  it("names branches added or removed and counts points below them", () => {
    const delta = diffMindMap(
      node("Case", [node("Evidence", [node("Payroll"), node("CCTV")]), node("Witnesses")]),
      node("Case", [node("Evidence", [node("Payroll"), node("Gate log")]), node("Damages", [node("Overtime")])]),
      false,
    );
    expect(delta).to.deep.equal({
      status: "changed",
      branchesAdded: ["Damages"],
      branchesRemoved: ["Witnesses"],
      pointsAdded: 3,
      pointsRemoved: 2,
      keptUserChanges: false,
    });
    // Branches count; points are shown only.
    expect(countChanges({ mindMap: delta })).to.equal(2);
  });

  it("is skipped when the map kept a lawyer's changes, and has nothing to compare for a first map", () => {
    expect(diffMindMap(node("Case"), node("Case"), true)).to.include({ status: "skipped", keptUserChanges: true });
    expect(diffMindMap(null, node("Case", [node("Evidence")]), false)).to.include({ status: "unchanged" });
  });
});

describe("audioOverviewDelta", () => {
  it("says a new overview was written, and never counts it", () => {
    const delta = audioOverviewDelta("ao-1");
    expect(delta).to.deep.equal({ status: "changed", overviewId: "ao-1" });
    expect(countChanges({ audioOverview: delta })).to.equal(0);
    expect(audioOverviewDelta(null)).to.deep.equal({ status: "skipped" });
  });
});

describe("countChanges", () => {
  it("counts nothing for a pane that was skipped or failed", () => {
    expect(countChanges({ redTeam: { status: "failed" }, outlook: { status: "skipped" } })).to.equal(0);
  });
});
