/** Lawyers' manual edits for the Change Summary: the pure helpers (which fields changed, folding
 * repeat edits, grouping into sessions), ManualEditLog's write rules, and the read service. No DB:
 * repositories and the access check are monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { fieldChanges, mergeEditChanges, normalizeEditValue } from "../src/utils/manual-edit-changes";
import { dayKeyOf, groupEditSessions } from "../src/utils/manual-edit-sessions";
import ManualEditLog from "../src/services/manual-edit-log.service";
import CaseManualEditSvc from "../src/services/case-manual-edit.service";
import CaseChangeSvc from "../src/services/case-change.service";
import CaseManualEditRepo from "../src/repositories/case-manual-edit.repository";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import CaseAccess from "../src/utils/case-access";
import { runWithRequestContext } from "../src/lib/request-context";

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

const at = (iso: string) => new Date(iso);

describe("fieldChanges", () => {
  it("names only the fields the patch actually changes, keeping from/to for short values", () => {
    const before = { label: "No signed contract", tag: "MINOR", impact: 2, detail: "Old text", dueDate: at("2026-10-01T00:00:00Z") };
    const changes = fieldChanges(
      before,
      { label: "No signed contract", tag: "MATERIAL", impact: undefined, detail: "New text", dueDate: "2026-10-09" },
      { label: "value", tag: "value", impact: "value", detail: "text", dueDate: "value" },
    );
    expect(changes).to.deep.equal([
      { field: "tag", from: "MINOR", to: "MATERIAL" },
      { field: "detail" },
      { field: "dueDate", from: "2026-10-01", to: "2026-10-09" },
    ]);
  });

  it("treats an emptied box as null and reads a missing row as nothing before", () => {
    expect(normalizeEditValue("  ")).to.equal(null);
    expect(fieldChanges(null, { title: "Payroll" }, { title: "value" })).to.deep.equal([{ field: "title", from: null, to: "Payroll" }]);
  });
});

describe("mergeEditChanges", () => {
  it("keeps each field's first from and latest to, and drops a field that ended where it began", () => {
    const merged = mergeEditChanges(
      [{ field: "impact", from: 2, to: 3 }, { field: "tag", from: "MINOR", to: "MATERIAL" }, { field: "detail" }],
      [{ field: "impact", from: 3, to: 5 }, { field: "tag", from: "MATERIAL", to: "MINOR" }],
    );
    expect(merged).to.deep.equal([{ field: "impact", from: 2, to: 5 }, { field: "detail" }]);
  });
});

describe("groupEditSessions", () => {
  const edit = (id: string, actorId: string, iso: string) => ({ id, actorId, createdAt: at(iso) });

  it("splits one person's edits on a gap over 30 minutes or a run in between, and keeps people apart", () => {
    const sessions = groupEditSessions(
      [
        edit("a1", "ana", "2026-10-08T09:00:00Z"),
        edit("a2", "ana", "2026-10-08T09:20:00Z"),
        edit("b1", "ben", "2026-10-08T09:10:00Z"),
        edit("a3", "ana", "2026-10-08T09:55:00Z"), // 35 minutes after a2
        edit("a4", "ana", "2026-10-08T10:05:00Z"), // a run saved at 10:00
      ],
      [at("2026-10-08T10:00:00Z")],
    );
    expect(sessions.map((s) => s.edits.map((e) => e.id))).to.deep.equal([["a4"], ["a3"], ["a1", "a2"], ["b1"]]);
    expect(sessions[2]).to.include({ id: "a1", actorId: "ana" });
  });

  it("splits days on the viewer's calendar", () => {
    expect(dayKeyOf(at("2026-10-07T20:30:00Z"), "Asia/Manila")).to.equal("2026-10-08");
  });
});

describe("ManualEditLog.record", () => {
  let created: any[];
  let updated: any[];
  let removed: string[];
  let recent: any;

  beforeEach(() => {
    created = [];
    updated = [];
    removed = [];
    recent = null;
    patch([
      [CaseManualEditRepo, "create", async (caseId: string, actorId: string | null, entry: any) => (created.push({ caseId, actorId, ...entry }), {})],
      [CaseManualEditRepo, "findRecentEdit", async () => recent],
      [CaseManualEditRepo, "updateChanges", async (id: string, label: string, changes: any) => (updated.push({ id, label, changes }), {})],
      [CaseManualEditRepo, "remove", async (id: string) => void removed.push(id)],
    ]);
  });

  afterEach(restoreAll);

  const edited = (changes: any[]) => ({ pane: "weaknesses", kind: "finding", itemId: "f1", action: "edited", label: "No signed contract", changes }) as const;

  it("writes an add or remove as it comes", async () => {
    await ManualEditLog.record("case-1", "ana", { pane: "witnesses", kind: "witness", itemId: "w1", action: "removed", label: "M. Reyes" });
    expect(created).to.deep.equal([{ caseId: "case-1", actorId: "ana", pane: "witnesses", kind: "witness", itemId: "w1", action: "removed", label: "M. Reyes" }]);
  });

  it("skips an edit that changed nothing", async () => {
    await ManualEditLog.record("case-1", "ana", edited([]));
    expect(created).to.have.length(0);
  });

  it("folds a repeat edit of the same item into the recent one, and removes it when it undid itself", async () => {
    recent = { id: "e1", changes: [{ field: "impact", from: 2, to: 3 }] };
    await ManualEditLog.record("case-1", "ana", edited([{ field: "impact", from: 3, to: 5 }]));
    expect(created).to.have.length(0);
    expect(updated).to.deep.equal([{ id: "e1", label: "No signed contract", changes: [{ field: "impact", from: 2, to: 5 }] }]);

    await ManualEditLog.record("case-1", "ana", edited([{ field: "impact", from: 3, to: 2 }]));
    expect(removed).to.deep.equal(["e1"]);
  });

  it("takes the actor from the request when none is passed", async () => {
    const context = { requestId: "r1", ip: null, userAgent: null, userId: () => "ben", organizationId: () => null, tenantCode: () => null };
    await runWithRequestContext(context, () =>
      ManualEditLog.record("case-1", undefined, { pane: "law", kind: "authority", itemId: "a1", action: "added", label: "Art. 297" }),
    );
    expect(created[0].actorId).to.equal("ben");
  });

  it("never fails the edit it describes", async () => {
    patch([[CaseManualEditRepo, "create", async () => Promise.reject(new Error("db down"))]]);
    await ManualEditLog.record("case-1", "ana", { pane: "damages", kind: "damage", itemId: "d1", action: "accepted", label: "13th month pay" });
  });
});

describe("Reading editing sessions", () => {
  const row = (id: string, actorId: string, iso: string) => ({
    id,
    actorId,
    createdAt: at(iso),
    pane: "weaknesses",
    kind: "finding",
    itemId: "f1",
    action: "edited",
    label: "No signed contract",
    changes: [{ field: "tag", from: "MINOR", to: "MATERIAL" }],
    actor: { id: actorId, name: actorId === "ana" ? "Ana Cruz" : null, username: `${actorId}.user` },
  });

  beforeEach(() => {
    patch([[CaseAccess, "loadAccessibleCase", async () => ({ id: "case-1" })]]);
  });

  afterEach(restoreAll);

  it("lists one day's sessions with who made them", async () => {
    patch([
      [CaseChangeSummaryRepo, "dayBounds", async () => ({ start: at("2026-10-07T16:00:00Z"), end: at("2026-10-08T16:00:00Z") })],
      [CaseManualEditRepo, "listBetween", async () => [row("e1", "ana", "2026-10-08T01:00:00Z"), row("e2", "ben", "2026-10-08T01:05:00Z")]],
      [CaseChangeSummaryRepo, "listTimes", async () => []],
    ]);
    const sessions = await CaseManualEditSvc.sessionsOnDay("case-1", "ana", "2026-10-08", "Asia/Manila");
    expect(sessions.map((s) => [s.actorName, s.editCount])).to.deep.equal([
      ["ben.user", 1],
      ["Ana Cruz", 1],
    ]);
    expect(sessions[1]!.edits[0]).to.include({ pane: "weaknesses", action: "edited", label: "No signed contract" });
  });

  it("counts the edits between the previous run's save and this run's start", async () => {
    let window: unknown[] = [];
    patch([
      [CaseChangeSummaryRepo, "findById", async () => ({ id: "s2", startedAt: at("2026-10-08T03:00:00Z"), createdAt: at("2026-10-08T03:05:00Z") })],
      [CaseChangeSummaryRepo, "previousBefore", async () => ({ id: "s1", createdAt: at("2026-10-08T00:00:00Z") })],
      [
        CaseManualEditRepo,
        "listBetween",
        async (_c: string, from: Date, to: Date) => (
          (window = [from, to]),
          [row("e1", "ana", "2026-10-08T01:00:00Z"), row("e2", "ana", "2026-10-08T01:10:00Z"), row("e3", "ben", "2026-10-08T02:00:00Z")]
        ),
      ],
    ]);
    const result = await CaseManualEditSvc.beforeRun("case-1", "ana", "s2");
    expect(window).to.deep.equal([at("2026-10-08T00:00:00Z"), at("2026-10-08T03:00:00Z")]);
    expect(result.count).to.equal(3);
    expect(result.actors.map((a) => a.name)).to.have.members(["Ana Cruz", "ben.user"]);
    expect(result.firstSession).to.deep.equal({ id: "e1", startedAt: at("2026-10-08T01:00:00Z") });
  });

  it("adds each day's editing sessions to the date picker, including days with edits only", async () => {
    patch([
      [CaseChangeSummaryRepo, "days", async () => [{ day: "2026-10-08", runs: 2, totalChanges: 9 }]],
      [
        CaseManualEditRepo,
        "listTimes",
        async () => [
          { id: "e1", actorId: "ana", createdAt: at("2026-10-08T01:00:00Z") },
          { id: "e2", actorId: "ana", createdAt: at("2026-10-06T01:00:00Z") },
        ],
      ],
      [CaseChangeSummaryRepo, "listTimes", async () => []],
    ]);
    expect(await CaseChangeSvc.days("case-1", "ana", "UTC")).to.deep.equal([
      { day: "2026-10-08", runs: 2, totalChanges: 9, editSessions: 1 },
      { day: "2026-10-06", runs: 0, totalChanges: 0, editSessions: 1 },
    ]);
  });
});
