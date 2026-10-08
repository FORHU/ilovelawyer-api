/** The analysis refresh's waves of side-by-side steps, and the rules the later-added steps
 * (witnesses, damages extraction, Red Team, the AI draft theory, Case Reconstruction) follow:
 * skip on a 409 (the same piece's own job holds its lock), never fail the refresh, and never
 * overwrite what a lawyer wrote.
 *
 * No live Postgres/Chat Wonder: every repository / service / util is monkeypatched on its
 * CommonJS module object, same idiom as test/case-refresh-audit-reason.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseRefreshSvc from "../src/services/case-refresh.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import CaseStrategySvc from "../src/services/case-strategy.service";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";
import CaseOutlookAiSvc from "../src/services/case-outlook-ai.service";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import DamagesExtractSvc from "../src/services/damages-extract.service";
import CaseTimelineSvc from "../src/services/case-timeline.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseSnapshotSvc from "../src/services/case-snapshot.service";
import RedTeamSvc from "../src/services/red-team.service";
import AudioOverviewSvc from "../src/services/audio-overview.service";
import WitnessExtractSvc from "../src/services/witness-extract.service";
import WitnessScoringSvc from "../src/services/witness-scoring.service";
import WitnessRepo from "../src/repositories/witness.repository";
import CaseTheorySvc from "../src/services/case-theory.service";
import CaseTheoryRepo from "../src/repositories/case-theory.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseReconstructionSvc from "../src/services/case-reconstruction.service";
import CaseReconstructionRepo from "../src/repositories/case-reconstruction.repository";
import CaseAccess from "../src/utils/case-access";
import CaseOutlookRepo from "../src/repositories/case-outlook.repository";
import RedTeamRepo from "../src/repositories/red-team.repository";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import CaseChangeReads from "../src/services/case-change-reads";
import * as chatWonder from "../src/utils/chatWonder";
import HttpError from "../src/utils/http-error";

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

// What scanContradictions now returns beside the rebuilt rows (see case-change-delta.spec.ts).
const noContradictionChanges = { status: "unchanged", added: [], addedCount: 0, dropped: [], droppedCount: 0, carriedOver: 0, droppedTriaged: 0 };

describe("Analysis refresh — waves of side-by-side steps", () => {
  // Every step records when it starts and when it ends, so a test can tell what overlapped.
  let events: string[];
  let audits: any[];
  let summaries: any[];
  // A step's stub: logs start, waits for `gate` (if any), logs end.
  const gates = new Map<string, Promise<void>>();
  function step(name: string, result: unknown = {}) {
    return async () => {
      events.push(`start:${name}`);
      await (gates.get(name) ?? Promise.resolve());
      events.push(`end:${name}`);
      return result;
    };
  }
  const WAVE_1 = ["contradictions", "strategy", "findings", "witnessExtract", "damagesExtract", "reconstruction"];
  const WAVE_2 = ["outlook", "damagesRerate", "witnessScore", "theory", "mindMap"];
  const started = () => events.filter((e) => e.startsWith("start:")).map((e) => e.slice(6));

  beforeEach(() => {
    events = [];
    audits = [];
    summaries = [];
    gates.clear();
    patch([
      [CaseRepo, "exists", async () => true],
      [CaseRepo, "markRefreshed", async () => ({ count: 1 })],
      [CaseRepo, "setReadySetFingerprint", async () => undefined],
      [DocumentRepo, "listAllByCase", async () => []],
      [EvidenceIntelligenceSvc, "scanContradictions", step("contradictions", { rows: [], delta: noContradictionChanges })],
      [CaseStrategySvc, "generateFromDocuments", step("strategy")],
      [CaseFindingAiSvc, "generateFromDocuments", step("findings")],
      [WitnessExtractSvc, "extractAllPending", step("witnessExtract", { batches: 1 })],
      [DamagesExtractSvc, "extractAllPending", step("damagesExtract", { batches: 1 })],
      [CaseReconstructionSvc, "autoRegenerate", step("reconstruction", "regenerated")],
      [CaseOutlookAiSvc, "generateFromDocuments", step("outlook", null)],
      [DamagesExtractSvc, "refreshStep", step("damagesRerate", { heads: 0 })],
      [WitnessScoringSvc, "scoreFromDocuments", step("witnessScore", { skipped: false })],
      [CaseTheorySvc, "refreshAiDraft", step("theory", { skipped: false })],
      [CaseMindMapSvc, "generateFromDocuments", step("mindMap", { skipped: null, map: null })],
      [RedTeamSvc, "generateFromDocuments", step("redTeam", { skipped: false })],
      [AudioOverviewSvc, "generateForCase", step("audioOverview", { skipped: false, id: "ao-1" })],
      [CaseTimelineSvc, "removeChatCopiedEvents", async () => 0],
      [OrganizationRepo, "writeAudit", async (data: any) => void audits.push(data)],
      [AiGenerationLockSvc, "finishWith", async (_c: string, _k: string, fn: () => Promise<unknown>) => fn()],
      [AiGenerationLockSvc, "setStage", async (_c: string, kind: string, stage: string) => void events.push(`stage:${kind}:${stage}`)],
      [CaseSnapshotSvc, "get", async () => ({})],
      // The change summary's before/after reads of each tracked pane, and its own row.
      [CaseFindingRepo, "list", async () => []],
      [CaseReconstructionRepo, "get", async () => null],
      [CaseOutlookRepo, "latest", async () => null],
      [RedTeamRepo, "get", async () => null],
      [CaseChangeSummaryRepo, "latestRefresh", async () => null],
      [CaseChangeSummaryRepo, "create", async (data: any) => (summaries.push(data), data)],
      [CaseRepo, "getLastRefreshedAt", async () => new Date("2026-10-01")],
      [CaseChangeReads, "strategy", async () => ({ items: [], dates: [] })],
      [CaseChangeReads, "witnesses", async () => []],
      [CaseChangeReads, "damages", async () => []],
      [CaseChangeReads, "theory", async () => null],
      [CaseChangeReads, "mindMap", async () => null],
    ]);
  });

  afterEach(restoreAll);

  it("runs every step once, in three waves: document readers, then what reads them, then Red Team and the Audio Overview", async () => {
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    const order = started();
    expect(order.slice(0, 6)).to.have.members(WAVE_1);
    expect(order.slice(6, 11)).to.have.members(WAVE_2);
    expect(order.slice(11)).to.have.members(["redTeam", "audioOverview"]);
  });

  it("starts a wave's steps together, and the next wave only once the slowest of them has finished", async () => {
    let releaseFindings!: () => void;
    gates.set("findings", new Promise<void>((resolve) => (releaseFindings = resolve)));
    const run = CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Findings is still running: the rest of wave 1 has started (and finished) beside it, but
    // nothing from wave 2 — it reads the findings.
    expect(started()).to.have.members(WAVE_1);
    expect(events).to.include("end:reconstruction");
    releaseFindings();
    await run;
    expect(events.indexOf("start:outlook")).to.be.greaterThan(events.indexOf("end:findings"));
    expect(events.indexOf("start:redTeam")).to.be.greaterThan(events.indexOf("end:mindMap"));
  });

  it("marks the job's stage as each later wave starts, so the app stops showing the timeline and the map as updating once their wave is over", async () => {
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    const wave2 = events.indexOf("stage:caseRefresh:wave2");
    const wave3 = events.indexOf("stage:caseRefresh:wave3");
    expect(wave2).to.be.greaterThan(events.indexOf("end:strategy"));
    expect(wave2).to.be.lessThan(events.indexOf("start:outlook"));
    expect(wave3).to.be.greaterThan(events.indexOf("end:mindMap"));
    expect(wave3).to.be.lessThan(events.indexOf("start:redTeam"));
  });

  it("still scores the existing witnesses when witness extraction fails", async () => {
    patch([[WitnessExtractSvc, "extractAllPending", async () => Promise.reject(new Error("chat-wonder timeout"))]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(started()).to.include("witnessScore");
  });

  it("skips a step whose own job holds its lock (409) and still runs the rest", async () => {
    patch([[CaseTheorySvc, "refreshAiDraft", async () => Promise.reject(new HttpError("caseTheoryPropose generation is already in progress", 409))]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(started()).to.include.members(["mindMap", "redTeam"]);
    expect(audits.filter((a) => a.action === "case.refresh")).to.have.length(1);
  });

  it("still completes the refresh when a step fails", async () => {
    patch([[RedTeamSvc, "generateFromDocuments", async () => Promise.reject(new Error("chat-wonder timeout"))]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(audits.filter((a) => a.action === "case.refresh")).to.have.length(1);
  });

  it("queues one map retry when another map build holds the map's lock", async () => {
    const scheduled: string[] = [];
    patch([
      [CaseMindMapSvc, "generateFromDocuments", async () => Promise.reject(new HttpError("caseMindMap generation is already in progress", 409))],
      [CaseMindMapSvc, "scheduleResync", async (caseId: string) => (scheduled.push(caseId), true)],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(scheduled).to.deep.equal(["case-1"]);
  });

  // Each tracked pane is read before its step and after it; these hand out `before` then `after`.
  const beforeThenAfter = (before: unknown, after: unknown) => {
    let calls = 0;
    return async () => (calls++ === 0 ? before : after);
  };

  it("saves one change summary with each tracked pane's difference, and links it from the audit row", async () => {
    patch([
      [
        EvidenceIntelligenceSvc,
        "scanContradictions",
        async () => ({ rows: [{}, {}], delta: { ...noContradictionChanges, status: "changed", addedCount: 2, carriedOver: 0 } }),
      ],
      [CaseFindingRepo, "list", beforeThenAfter([], [{ category: "WEAKNESS", label: "No signed contract", tag: null, impact: null }])],
      [
        CaseOutlookRepo,
        "latest",
        beforeThenAfter(
          { id: "o1", band: "LEANS_FAVORABLE", confidence: "MEDIUM", drivers: [] },
          { id: "o2", band: "UNCERTAIN", confidence: "MEDIUM", drivers: [] },
        ),
      ],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");

    expect(summaries).to.have.length(1);
    const [summary] = summaries;
    expect(summary).to.include({ caseId: "case-1", reason: "post-extraction", actorId: "user-1", totalChanges: 4 });
    expect(summary.perPaneDeltas.contradictions.addedCount).to.equal(2);
    expect(summary.perPaneDeltas.findings.byCategory.WEAKNESS.added).to.deep.equal(["No signed contract"]);
    expect(summary.perPaneDeltas.outlook.band).to.deep.equal({ from: "LEANS_FAVORABLE", to: "UNCERTAIN" });
    expect(summary.perPaneDeltas.reconstruction).to.include({ status: "unchanged", outcome: "regenerated" });
    expect(audits.find((a) => a.action === "case.refresh").payload).to.include({ changeSummaryId: summary.id, totalChanges: 4 });
  });

  it("marks a pane failed when its step throws and skipped when its own job holds the lock, and still saves the summary", async () => {
    patch([
      [RedTeamSvc, "generateFromDocuments", async () => Promise.reject(new Error("chat-wonder timeout"))],
      [CaseOutlookAiSvc, "generateFromDocuments", async () => Promise.reject(new HttpError("caseOutlook generation is already in progress", 409))],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "manual");
    expect(summaries[0].perPaneDeltas.redTeam).to.deep.equal({ status: "failed" });
    expect(summaries[0].perPaneDeltas.outlook).to.deep.equal({ status: "skipped" });
  });

  it("records Red Team as skipped when there was nothing for it to attack", async () => {
    patch([[RedTeamSvc, "generateFromDocuments", async () => ({ skipped: true })]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "manual");
    expect(summaries[0].perPaneDeltas.redTeam).to.deep.equal({ status: "skipped" });
  });

  it("names the documents added since the previous summary, and none on a case's first summary", async () => {
    patch([
      [
        DocumentRepo,
        "listAllByCase",
        async () => [
          { id: "d1", name: "Termination letter", ragStatus: "READY" },
          { id: "d2", name: "Payroll", ragStatus: "READY" },
          { id: "d3", name: "Old memo", ragStatus: "READY", status: "ARCHIVED" },
        ],
      ],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(summaries[0]).to.deep.include({ readyDocumentIds: ["d1", "d2"], documentsAdded: [], documentsRemoved: [] });

    expect(summaries[0].firstAnalysis).to.equal(false);

    patch([[CaseChangeSummaryRepo, "latestRefresh", async () => ({ readyDocumentIds: ["d1", "d9"] })]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(summaries[1].documentsAdded).to.deep.equal([{ id: "d2", name: "Payroll" }]);
    expect(summaries[1].documentsRemoved).to.deep.equal([{ id: "d9", name: null }]);
  });

  it("compares witnesses from before wave 1 to after wave 2, so both witness steps count", async () => {
    patch([
      [
        CaseChangeReads,
        "witnesses",
        beforeThenAfter([{ name: "J. Cruz", credibility: 50, aiCredibility: 70 }], [
          { name: "J. Cruz", credibility: 50, aiCredibility: 45 },
          { name: "M. Reyes", credibility: 50 },
        ]),
      ],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(summaries[0].perPaneDeltas.witnesses).to.deep.equal({
      status: "changed",
      added: ["M. Reyes"],
      removed: [],
      rescored: [{ name: "J. Cruz", from: 70, to: 45 }],
    });
  });

  it("still shows what changed in a two-step pane when one of its steps failed, and says failed when nothing did", async () => {
    patch([
      [WitnessExtractSvc, "extractAllPending", async () => Promise.reject(new Error("chat-wonder timeout"))],
      [CaseChangeReads, "witnesses", beforeThenAfter([{ name: "J. Cruz", credibility: 50, aiCredibility: 70 }], [{ name: "J. Cruz", credibility: 50, aiCredibility: 40 }])],
      [DamagesExtractSvc, "extractAllPending", async () => Promise.reject(new Error("chat-wonder timeout"))],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(summaries[0].perPaneDeltas.witnesses.status).to.equal("changed");
    expect(summaries[0].perPaneDeltas.damages).to.deep.equal({ status: "failed" });
  });

  it("records the strategy, theory, map and audio overview steps", async () => {
    patch([
      [
        CaseChangeReads,
        "strategy",
        beforeThenAfter({ items: [], dates: [] }, { items: [{ kind: "TODO", label: "Request payroll records" }], dates: [] }),
      ],
      [
        CaseChangeReads,
        "theory",
        beforeThenAfter(
          { title: "Unpaid overtime", claims: [], assumptions: [], openQuestions: [] },
          { title: "Unpaid overtime", claims: [{ statement: "Overtime was ordered", stance: "ASSERTS" }], assumptions: [], openQuestions: [] },
        ),
      ],
      [CaseMindMapSvc, "generateFromDocuments", async () => ({ skipped: "userChanges", map: null })],
    ]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    const d = summaries[0].perPaneDeltas;
    expect(d.strategy).to.include({ status: "changed" }).and.deep.include({ todosAdded: ["Request payroll records"] });
    expect(d.theory).to.include({ status: "changed" }).and.deep.include({ claimsAdded: ["Overtime was ordered"] });
    expect(d.mindMap).to.include({ status: "skipped", keptUserChanges: true });
    expect(d.audioOverview).to.deep.equal({ status: "changed", overviewId: "ao-1" });
    // 1 to-do + 1 claim; the audio overview never counts.
    expect(summaries[0].totalChanges).to.equal(2);
  });

  it("flags the case's first analysis, so the banner doesn't list every pane's first content as changes", async () => {
    patch([[CaseRepo, "getLastRefreshedAt", async () => null]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(summaries[0].firstAnalysis).to.equal(true);
  });

  it("still completes the refresh when the summary can't be saved", async () => {
    patch([[CaseChangeSummaryRepo, "create", async () => Promise.reject(new Error("db down"))]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    const audit = audits.find((a) => a.action === "case.refresh");
    expect(audit).to.exist;
    expect(audit.payload).not.to.have.property("changeSummaryId");
  });

  it("still runs a tracked step when the read before it fails, and only loses that pane's difference", async () => {
    patch([[CaseFindingRepo, "list", async () => Promise.reject(new Error("db blip"))]]);
    await CaseRefreshSvc.runQueued("case-1", "user-1", "post-extraction");
    expect(started()).to.include("findings");
    expect(summaries[0].perPaneDeltas).not.to.have.property("findings");
  });
});

describe("RedTeamSvc.generateFromDocuments", () => {
  afterEach(restoreAll);

  const emptyData = { legalIssues: [], weaknesses: [], contradictions: [] };

  it("skips a case with no findings and no contradictions", async () => {
    let ran = false;
    patch([
      [RedTeamSvc, "promptDataFor", async () => emptyData],
      [AiGenerationLockSvc, "run", async () => void (ran = true)],
    ]);
    expect(await RedTeamSvc.generateFromDocuments("case-1", "user-1")).to.deep.equal({ skipped: true });
    expect(ran).to.equal(false);
  });

  it("regenerates under the redTeam lock once there is something to attack", async () => {
    const kinds: string[] = [];
    patch([
      [RedTeamSvc, "promptDataFor", async () => ({ ...emptyData, weaknesses: ["No signed contract"] })],
      [AiGenerationLockSvc, "run", async (_c: string, kind: string) => void kinds.push(kind)],
    ]);
    expect(await RedTeamSvc.generateFromDocuments("case-1", "user-1")).to.deep.equal({ skipped: false });
    expect(kinds).to.deep.equal(["redTeam"]);
  });
});

describe("CaseTheorySvc — one AI draft per case", () => {
  const reply = `[THEORY_PROPOSAL]
{"title": "Known defects", "thesis": "The owner knew of the defects and did nothing.", "claims": [{"statement": "Defects were reported", "stance": "ASSERTS"}], "assumptions": ["Reports reached the owner"], "openQuestions": ["Who read the reports?"]}
[/THEORY_PROPOSAL]`;
  let created: any[];
  let replaced: any[];
  let audits: any[];

  beforeEach(() => {
    created = [];
    replaced = [];
    audits = [];
    patch([
      [CaseAccess, "resolveTenantCode", async () => "PH"],
      [CaseFindingRepo, "list", async () => [{ category: "WEAKNESS", label: "No signed contract" }]],
      [chatWonder, "getChatWonderSessionId", async () => "sess-1"],
      [chatWonder, "streamChatWonderMessage", async () => ({ content: reply })],
      [CaseGraphSvc, "ensureNode", async () => ({ id: "node-1" })],
      [CaseTheoryRepo, "create", async (_c: string, data: any) => (created.push(data), { id: "th-new", ...data })],
      [CaseTheoryRepo, "addClaim", async () => ({})],
      [CaseTheoryRepo, "addAssumption", async () => ({})],
      [CaseTheoryRepo, "addOpenQuestion", async () => ({})],
      [CaseTheoryRepo, "replaceAiDraft", async (id: string, _c: string, proposal: any) => (replaced.push({ id, proposal }), { id })],
      [CaseTheoryRepo, "findById", async (id: string) => ({ id })],
      [OrganizationRepo, "writeAudit", async (data: any) => void audits.push(data)],
      [AiGenerationLockSvc, "run", async (_c: string, _k: string, fn: () => Promise<unknown>) => fn()],
    ]);
  });

  afterEach(restoreAll);

  it("creates the AI draft when the case has none", async () => {
    patch([[CaseTheoryRepo, "findLatestAiDraft", async () => null]]);
    await CaseTheorySvc.refreshAiDraft("case-1", "user-1");
    expect(created).to.have.length(1);
    expect(created[0]).to.include({ authorUserId: null, title: "Known defects" });
    expect(replaced).to.have.length(0);
  });

  it("rewrites the existing AI draft in place instead of adding another", async () => {
    patch([[CaseTheoryRepo, "findLatestAiDraft", async () => ({ id: "th-ai" })]]);
    await CaseTheorySvc.refreshAiDraft("case-1", "user-1");
    expect(created).to.have.length(0);
    expect(replaced).to.have.length(1);
    expect(replaced[0].id).to.equal("th-ai");
    expect(replaced[0].proposal.claims).to.deep.equal([{ statement: "Defects were reported", stance: "ASSERTS" }]);
    expect(audits[0].payload).to.include({ id: "th-ai", replaced: true });
  });

  it("skips quietly when the case has no findings yet", async () => {
    patch([[CaseFindingRepo, "list", async () => []]]);
    expect(await CaseTheorySvc.refreshAiDraft("case-1", "user-1")).to.deep.equal({ skipped: true });
    expect(created).to.have.length(0);
  });
});

describe("CaseReconstructionSvc.autoRegenerate", () => {
  let generated: number;

  function setup(existing: unknown) {
    generated = 0;
    patch([
      [CaseReconstructionRepo, "get", async () => existing],
      [CaseReconstructionSvc, "generate", async () => void generated++],
    ]);
  }

  afterEach(restoreAll);

  it("generates the first narrative", async () => {
    setup(null);
    expect(await CaseReconstructionSvc.autoRegenerate("case-1", "user-1")).to.equal("generated");
    expect(generated).to.equal(1);
  });

  it("leaves a narrative the lawyer edited alone", async () => {
    setup({ narrativeEditedAt: new Date() });
    expect(await CaseReconstructionSvc.autoRegenerate("case-1", "user-1")).to.equal("skipped-edited");
    expect(generated).to.equal(0);
  });

  it("regenerates an untouched narrative", async () => {
    setup({ narrativeEditedAt: null });
    expect(await CaseReconstructionSvc.autoRegenerate("case-1", "user-1")).to.equal("regenerated");
    expect(generated).to.equal(1);
  });
});

describe("Witness steps of the analysis refresh", () => {
  afterEach(restoreAll);

  it("extractAllPending reads batch after batch under one witnessExtract lock until none are left", async () => {
    const kinds: string[] = [];
    let remaining = 3;
    const scheduled: string[] = [];
    patch([
      [DocumentRepo, "listPendingWitnessExtraction", async () => Array.from({ length: remaining }, (_, i) => ({ id: `d${i}` }))],
      [AiGenerationLockSvc, "run", async (_c: string, kind: string, fn: () => Promise<unknown>) => (kinds.push(kind), fn())],
      [WitnessExtractSvc, "extractBatch", async () => --remaining > 0],
      [WitnessExtractSvc, "schedule", (caseId: string) => void scheduled.push(caseId)],
    ]);
    expect(await WitnessExtractSvc.extractAllPending("case-1", "user-1")).to.deep.equal({ batches: 3 });
    expect(kinds).to.deep.equal(["witnessExtract"]);
    expect(scheduled).to.deep.equal([]);
  });

  it("extractAllPending hands what's left to the queued job past its batch cap", async () => {
    const scheduled: string[] = [];
    patch([
      [DocumentRepo, "listPendingWitnessExtraction", async () => [{ id: "d1" }]],
      [AiGenerationLockSvc, "run", async (_c: string, _k: string, fn: () => Promise<unknown>) => fn()],
      [WitnessExtractSvc, "extractBatch", async () => true],
      [WitnessExtractSvc, "schedule", (caseId: string) => void scheduled.push(caseId)],
    ]);
    const { batches } = await WitnessExtractSvc.extractAllPending("case-1", "user-1");
    expect(batches).to.equal(25);
    expect(scheduled).to.deep.equal(["case-1"]);
  });

  it("damages extractAllPending reads every pending document under one damagesExtract lock, the same way", async () => {
    const kinds: string[] = [];
    let remaining = 2;
    patch([
      [DocumentRepo, "listPendingDamagesExtraction", async () => Array.from({ length: remaining }, (_, i) => ({ id: `d${i}` }))],
      [AiGenerationLockSvc, "run", async (_c: string, kind: string, fn: () => Promise<unknown>) => (kinds.push(kind), fn())],
      [DamagesExtractSvc, "extractBatch", async () => --remaining > 0],
    ]);
    expect(await DamagesExtractSvc.extractAllPending("case-1", "user-1")).to.deep.equal({ batches: 2 });
    expect(kinds).to.deep.equal(["damagesExtract"]);
  });

  it("extractAllPending takes no lock when every document has been read", async () => {
    let locked = false;
    patch([
      [DocumentRepo, "listPendingWitnessExtraction", async () => []],
      [AiGenerationLockSvc, "run", async () => void (locked = true)],
    ]);
    expect(await WitnessExtractSvc.extractAllPending("case-1", "user-1")).to.deep.equal({ batches: 0 });
    expect(locked).to.equal(false);
  });

  it("scoreFromDocuments skips a case with no witnesses and scores under the witnessScoring lock otherwise", async () => {
    const kinds: string[] = [];
    let witnesses: unknown[] = [];
    patch([
      [WitnessRepo, "list", async () => witnesses],
      [AiGenerationLockSvc, "run", async (_c: string, kind: string) => void kinds.push(kind)],
    ]);
    expect(await WitnessScoringSvc.scoreFromDocuments("case-1", "user-1")).to.deep.equal({ skipped: true });
    witnesses = [{ id: "w1" }];
    expect(await WitnessScoringSvc.scoreFromDocuments("case-1", "user-1")).to.deep.equal({ skipped: false });
    expect(kinds).to.deep.equal(["witnessScoring"]);
  });
});
