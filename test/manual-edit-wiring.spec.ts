/** Each pane's edit methods record a manual edit with the item's name — including deletes, which the
 * audit log never named. Repositories, the access check and ManualEditLog are monkeypatched; this
 * checks what each method hands the log, not how the log stores it (manual-edit-log.spec.ts). */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ManualEditLog from "../src/services/manual-edit-log.service";
import CaseAccess from "../src/utils/case-access";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseFindingSvc from "../src/services/case-finding.service";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import WitnessSvc from "../src/services/witness.service";
import WitnessRepo from "../src/repositories/witness.repository";
import DamageClaimSvc from "../src/services/damage-claim.service";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import EvidenceRepo from "../src/repositories/evidence.repository";
import ProceduralDeadlineSvc from "../src/services/procedural-deadline.service";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseTimelineSvc from "../src/services/case-timeline.service";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import DecisionRecordSvc from "../src/services/decision-record.service";
import DecisionRecordRepo from "../src/repositories/decision-record.repository";
import AnnotationRepo from "../src/repositories/annotation.repository";

type Patch = [object, string, unknown];
const restores: Patch[] = [];
function patch(patches: Patch[]) {
  for (const [target, key, value] of patches) {
    restores.push([target, key, (target as any)[key]]);
    (target as any)[key] = value;
  }
}
function restoreAll() {
  while (restores.length) {
    const [target, key, value] = restores.pop()!;
    (target as any)[key] = value;
  }
}

describe("Manual edits recorded by each pane's edit methods", () => {
  let logged: any[];

  beforeEach(() => {
    logged = [];
    patch([
      [ManualEditLog, "record", async (_caseId: string, actorId: string, entry: any) => void logged.push({ actorId, ...entry })],
      [CaseAccess, "assertCanEdit", async () => undefined],
      [OrganizationRepo, "writeAudit", async () => undefined],
      [CaseGraphSvc, "ensureNode", async () => ({ id: "node" })],
      [CaseGraphSvc, "markStale", async () => undefined],
      [CaseGraphSvc, "removeNode", async () => undefined],
      [ProceduralDeadlineRepo, "closeLinked", async () => undefined],
    ]);
  });

  afterEach(restoreAll);

  it("Weaknesses: a re-rating names the finding and the tag change", async () => {
    const existing = { id: "f1", category: "WEAKNESS", label: "No signed contract", detail: null, tag: "MINOR", impact: 2 };
    patch([
      [CaseFindingRepo, "find", async () => existing],
      [CaseFindingRepo, "update", async (_id: string, _c: string, data: any) => ({ ...existing, ...data })],
    ]);
    await CaseFindingSvc.update("case-1", "f1", "ana", { tag: "MATERIAL" } as any);
    expect(logged).to.deep.equal([
      {
        actorId: "ana",
        pane: "weaknesses",
        kind: "finding",
        itemId: "f1",
        action: "edited",
        label: "No signed contract",
        changes: [{ field: "tag", from: "MINOR", to: "MATERIAL" }],
      },
    ]);
  });

  it("Legal Issues: a delete still names the finding", async () => {
    patch([
      [CaseFindingRepo, "find", async () => ({ id: "f2", category: "LEGAL_ISSUE", label: "Was the dismissal for just cause?" })],
      [CaseFindingRepo, "delete", async () => true],
    ]);
    await CaseFindingSvc.delete("case-1", "f2", "ana");
    expect(logged[0]).to.include({ pane: "legalIssues", action: "removed", label: "Was the dismissal for just cause?" });
  });

  it("Witnesses: a delete names the witness", async () => {
    patch([
      [WitnessRepo, "find", async () => ({ id: "w1", name: "M. Reyes" })],
      [WitnessRepo, "delete", async () => true],
    ]);
    await WitnessSvc.delete("case-1", "w1", "ana");
    expect(logged[0]).to.include({ pane: "witnesses", kind: "witness", action: "removed", label: "M. Reyes" });
  });

  it("Damages & Remedies: accepting a proposal, and an amount change", async () => {
    const existing = { id: "d1", kind: "DAMAGE", title: "13th month pay", amount: 20000, done: false, dueDate: null, description: null };
    patch([
      [DamageClaimRepo, "update", async (_id: string, _c: string, data: any) => ({ ...existing, ...data })],
      [DamageClaimRepo, "findById", async () => existing],
    ]);
    await DamageClaimSvc.accept("case-1", "d1", "ana");
    await DamageClaimSvc.update("case-1", "d1", "ana", { amount: 25000 } as any);
    expect(logged.map((e) => [e.action, e.label])).to.deep.equal([
      ["accepted", "13th month pay"],
      ["edited", "13th month pay"],
    ]);
    expect(logged[1].changes).to.deep.equal([{ field: "amount", from: 20000, to: 25000 }]);
  });

  it("Evidence & Timeline: resolving a contradiction, and nothing when the status didn't move", async () => {
    const before = { id: "c1", status: "OPEN", factKey: "incident_date", leftValue: "4 Aug", rightValue: "8 Aug" };
    patch([
      [EvidenceRepo, "findContradiction", async () => before],
      [EvidenceRepo, "updateContradictionStatus", async (_id: string, _c: string, data: any) => ({ ...before, ...data })],
    ]);
    await EvidenceIntelligenceSvc.updateContradiction("case-1", "c1", "ana", { status: "RESOLVED", resolutionNote: "Payroll lag" } as any);
    expect(logged[0]).to.deep.include({
      pane: "evidence",
      kind: "contradiction",
      action: "resolved",
      label: "incident_date: 4 Aug vs 8 Aug",
      changes: [{ field: "resolutionNote" }],
    });

    logged = [];
    patch([[EvidenceRepo, "findContradiction", async () => ({ ...before, status: "RESOLVED" })]]);
    await EvidenceIntelligenceSvc.updateContradiction("case-1", "c1", "ana", { status: "RESOLVED" } as any);
    expect(logged).to.have.length(0);
  });

  it("Evidence & Timeline: removing a timeline entry names it", async () => {
    patch([
      [CaseTimelineRepo, "findById", async () => ({ id: "t1", title: "Last salary paid" })],
      [CaseTimelineRepo, "delete", async () => true],
    ]);
    await CaseTimelineSvc.delete("case-1", "t1", "ana");
    expect(logged[0]).to.include({ pane: "evidence", kind: "timelineEntry", action: "removed", label: "Last salary paid" });
  });

  it("Case Strategy: ticking a to-do", async () => {
    const before = { id: "p1", label: "Request payroll records", done: false, notes: null, sourceKind: null, sourceId: null };
    patch([
      [ProceduralDeadlineRepo, "findProcedureItem", async () => before],
      [ProceduralDeadlineRepo, "updateProcedureItem", async (_id: string, _c: string, data: any) => ({ ...before, ...data })],
    ]);
    await ProceduralDeadlineSvc.updateItem("case-1", "p1", "ana", { done: true });
    expect(logged.map((e) => [e.action, e.label])).to.deep.equal([
      ["ticked", "Request payroll records"],
      ["edited", "Request payroll records"],
    ]);
    // The "edited" call carries no changes, so ManualEditLog drops it.
    expect(logged[1].changes).to.deep.equal([]);
  });

  it("Decisions: disputing names the decision and notes the note", async () => {
    patch([
      [DecisionRecordRepo, "updateStatus", async () => ({ id: "r1", anchor: "Dismissal was for just cause" })],
      [AnnotationRepo, "create", async () => ({})],
    ]);
    await DecisionRecordSvc.dispute("case-1", "r1", "ana", "The memo was never served");
    expect(logged[0]).to.deep.include({ pane: "decisions", action: "disputed", label: "Dismissal was for just cause", changes: [{ field: "disputeNote" }] });
  });
});
