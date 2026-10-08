/** Each Terminal pane's own Regenerate: every route claims its pane's lock before queueing (so a
 * double click is a 409 at once), queues its own job kind, and refuses while the case analysis is
 * running. Covers the three new finding categories and the four panes that had no single-pane
 * action (Case Summary's outlook, Witnesses, Damages, Audio Overview). Repositories, access check
 * and queue are monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseTerminalCtrl from "../src/controllers/case-terminal.controller";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import CaseAccess from "../src/utils/case-access";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";
import WitnessScoringSvc from "../src/services/witness-scoring.service";
import WitnessExtractSvc from "../src/services/witness-extract.service";
import DamagesExtractSvc from "../src/services/damages-extract.service";
import HttpError from "../src/utils/http-error";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import RedTeamRepo from "../src/repositories/red-team.repository";
import RedTeamSvc from "../src/services/red-team.service";
import EvidenceIntelligenceSvc from "../src/services/evidence-intelligence.service";
import CaseChangeReads from "../src/services/case-change-reads";

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

function response() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => ((res.statusCode = code), res);
  res.json = (body: unknown) => ((res.body = body), res);
  return res;
}

describe("A pane's own Regenerate routes", () => {
  let begun: string[];
  let queued: { kind: string; caseId: string }[];
  let analysisRunning: boolean;

  const req = (body: unknown = {}) => ({ params: { caseId: "case-1" }, user: { userId: "user-1" }, body }) as any;

  beforeEach(() => {
    begun = [];
    queued = [];
    analysisRunning = false;
    patch([
      [CaseAccess, "assertCanEdit", async () => ({ id: "case-1" })],
      [
        AiGenerationLockSvc,
        "getStatus",
        async (_c: string, kind: string) =>
          kind === "caseRefresh"
            ? analysisRunning
              ? { status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date() }
              : { status: "DONE", startedAt: new Date() }
            : { kind, status: "IN_PROGRESS" },
      ],
      [AiGenerationLockSvc, "begin", async (_c: string, kind: string) => void begun.push(kind)],
      [AiGenerationQueue, "enqueue", (job: any) => void queued.push({ kind: job.kind, caseId: job.caseId })],
      [CaseFindingRepo, "list", async () => [{ category: "WEAKNESS", label: "No signed contract" }]],
    ]);
  });

  afterEach(restoreAll);

  for (const [category, kind] of [
    ["LEGAL_ISSUE", "legalIssueRegenerate"],
    ["ATTACK_STRATEGY", "attackRegenerate"],
    ["DEFENSE_STRATEGY", "defenseRegenerate"],
  ] as const) {
    it(`regenerates only ${category} findings under ${kind}`, async () => {
      // beginCategory reads the findings and refresh jobs: idle for this test.
      patch([[AiGenerationLockSvc, "getStatus", async () => null]]);
      const res = response();
      await CaseTerminalCtrl.regenerateFindings(req({ category }), res);
      expect(res.statusCode).to.equal(202);
      expect(begun).to.deep.equal([kind]);
      expect(queued).to.deep.equal([{ kind, caseId: "case-1" }]);
    });
  }

  for (const [handler, lock, jobKind] of [
    ["generateOutlook", "caseOutlook", "caseOutlookGenerate"],
    ["refreshWitnesses", "witnessRefresh", "witnessRefresh"],
    ["refreshDamages", "damagesRefresh", "damagesRefresh"],
    ["generateAudioOverview", "audioOverviewScript", "audioOverviewGenerate"],
  ] as const) {
    it(`${handler} claims ${lock} and queues ${jobKind}`, async () => {
      const res = response();
      await (CaseTerminalCtrl as any)[handler](req(), res);
      expect(res.statusCode).to.equal(202);
      expect(begun).to.deep.equal([lock]);
      expect(queued).to.deep.equal([{ kind: jobKind, caseId: "case-1" }]);
    });

    it(`${handler} is refused (409) while the case analysis runs, before claiming anything`, async () => {
      analysisRunning = true;
      let error: any;
      await (CaseTerminalCtrl as any)[handler](req(), response()).catch((err: unknown) => (error = err));
      expect(error).to.be.instanceOf(HttpError);
      expect(error.statusCode).to.equal(409);
      expect(begun).to.deep.equal([]);
      expect(queued).to.deep.equal([]);
    });
  }

  it("refuses an Audio Overview for a case with no findings yet (422)", async () => {
    patch([[CaseFindingRepo, "list", async () => []]]);
    let error: any;
    await CaseTerminalCtrl.generateAudioOverview(req(), response()).catch((err) => (error = err));
    expect(error?.statusCode).to.equal(422);
    expect(queued).to.deep.equal([]);
  });
});

describe("A pane's own Regenerate runs", () => {
  let order: string[];

  beforeEach(() => {
    order = [];
    patch([
      [AiGenerationLockSvc, "finishWith", async (_c: string, kind: string, fn: () => Promise<unknown>) => (order.push(`lock:${kind}`), fn())],
      // The change summary's reads around each run — see "A pane's Regenerate updates the change summary".
      [CaseChangeReads, "witnesses", async () => []],
      [CaseChangeReads, "damages", async () => []],
      [CaseChangeSummaryRepo, "create", async (data: unknown) => data],
    ]);
  });

  afterEach(restoreAll);

  it("a findings category runs under its own kind", async () => {
    patch([
      [CaseFindingAiSvc as any, "generateFromDocumentsInner", async (_c: string, only: string) => void order.push(`findings:${only}`)],
      // The change summary's reads around the run — see "A pane's Regenerate updates the change summary".
      [CaseFindingRepo, "list", async () => []],
      [CaseChangeSummaryRepo, "create", async (data: unknown) => data],
    ]);
    await CaseFindingAiSvc.runQueuedCategory("case-1", "ATTACK_STRATEGY");
    expect(order).to.deep.equal(["lock:attackRegenerate", "findings:ATTACK_STRATEGY"]);
  });

  it("Witnesses reads new documents, then scores — and still scores when a reading pass is already running", async () => {
    patch([
      [WitnessExtractSvc, "extractAllPending", async () => Promise.reject(new HttpError("witnessExtract generation is already in progress", 409))],
      [WitnessScoringSvc, "scoreFromDocuments", async () => (order.push("score"), { skipped: false })],
    ]);
    await WitnessScoringSvc.runQueuedRefresh("case-1", "user-1");
    expect(order).to.deep.equal(["lock:witnessRefresh", "score"]);
  });

  it("Damages reads new documents, then re-rates every item", async () => {
    patch([
      [DamagesExtractSvc, "extractAllPending", async () => (order.push("extract"), { batches: 1 })],
      [DamagesExtractSvc, "refreshStep", async () => (order.push("rerate"), { heads: 2 })],
    ]);
    await DamagesExtractSvc.runQueuedRefresh("case-1", "user-1");
    expect(order).to.deep.equal(["lock:damagesRefresh", "extract", "rerate"]);
  });
});

describe("A pane's Regenerate updates the change summary", () => {
  let order: string[];
  let summaries: any[];
  // Hands out `before` on the first read and `after` on the second.
  const beforeThenAfter = (before: unknown, after: unknown) => {
    let calls = 0;
    return async () => (calls++ === 0 ? before : after);
  };
  const assessment = (riskOfLoss: number, titles: string[]) => ({
    arguments: { opponent: "Northgate", riskOfLoss, arguments: titles.map((title) => ({ title, strength: "MODERATE" })) },
  });

  beforeEach(() => {
    order = [];
    summaries = [];
    patch([
      // Records when the job would read as DONE, so a test can check the summary came first.
      [
        AiGenerationLockSvc,
        "finishWith",
        async (_c: string, kind: string, fn: () => Promise<unknown>) => {
          const result = await fn();
          order.push(`done:${kind}`);
          return result;
        },
      ],
      [CaseChangeSummaryRepo, "create", async (data: any) => (order.push("summary"), summaries.push(data), data)],
    ]);
  });

  afterEach(restoreAll);

  it("Red Team saves a summary of that pane alone, before its job reads as done", async () => {
    patch([
      [RedTeamRepo, "get", beforeThenAfter(assessment(38, ["Abandonment of work"]), assessment(47, ["Abandonment of work", "Waiver"]))],
      [RedTeamSvc as any, "generateInner", async () => ({ id: "rt-1" })],
    ]);
    await RedTeamSvc.runQueued("case-1", "user-1");

    expect(order).to.deep.equal(["summary", "done:redTeam"]);
    expect(summaries[0]).to.deep.include({
      caseId: "case-1",
      reason: "regenerate",
      actorId: "user-1",
      readyDocumentIds: [],
      documentsAdded: [],
      documentsRemoved: [],
      firstAnalysis: false,
      totalChanges: 2,
    });
    expect(summaries[0].perPaneDeltas).to.have.keys("redTeam");
    expect(summaries[0].perPaneDeltas.redTeam).to.deep.include({ added: ["Waiver"], riskOfLoss: { from: 38, to: 47 } });
  });

  it("a findings panel names its category, so the banner can name the panel even when nothing changed", async () => {
    const rows = [{ category: "WEAKNESS", label: "No signed contract", tag: null, impact: null }];
    patch([
      [CaseFindingRepo, "list", async () => rows],
      [CaseFindingAiSvc as any, "generateFromDocumentsInner", async () => rows],
    ]);
    await CaseFindingAiSvc.runQueuedCategory("case-1", "WEAKNESS", "user-1");
    expect(summaries[0].perPaneDeltas).to.deep.equal({ findings: { status: "unchanged", byCategory: {}, category: "WEAKNESS" } });
  });

  it("the contradictions Scan records the delta the scan itself returns", async () => {
    const delta = { status: "changed", added: [], addedCount: 3, dropped: [], droppedCount: 0, carriedOver: 1, droppedTriaged: 0 };
    patch([[EvidenceIntelligenceSvc as any, "scanContradictionsInner", async () => ({ rows: [], delta })]]);
    await EvidenceIntelligenceSvc.runQueuedScan("case-1", "user-1");
    expect(summaries[0].perPaneDeltas).to.deep.equal({ contradictions: delta });
    expect(summaries[0].totalChanges).to.equal(3);
  });

  it("Witnesses names the witness its run found", async () => {
    patch([
      [CaseChangeReads, "witnesses", (() => {
        let calls = 0;
        return async () => (calls++ === 0 ? [] : [{ name: "M. Reyes", credibility: 50 }]);
      })()],
      [WitnessExtractSvc, "extractAllPending", async () => ({ batches: 1 })],
      [WitnessScoringSvc, "scoreFromDocuments", async () => ({ skipped: false })],
    ]);
    await WitnessScoringSvc.runQueuedRefresh("case-1", "user-1");
    expect(order).to.deep.equal(["summary", "done:witnessRefresh"]);
    expect(summaries[0].perPaneDeltas).to.deep.equal({ witnesses: { status: "changed", added: ["M. Reyes"], removed: [], rescored: [] } });
  });

  it("saves nothing when the run fails, and still fails the job", async () => {
    patch([
      [RedTeamRepo, "get", async () => null],
      [RedTeamSvc as any, "generateInner", async () => Promise.reject(new Error("chat-wonder timeout"))],
    ]);
    let failed = false;
    await RedTeamSvc.runQueued("case-1", "user-1").catch(() => (failed = true));
    expect(failed).to.equal(true);
    expect(summaries).to.have.length(0);
  });

  it("still runs the pane when the read before it fails, and saves no summary without a comparison", async () => {
    let ran = false;
    patch([
      [RedTeamRepo, "get", async () => Promise.reject(new Error("db blip"))],
      [RedTeamSvc as any, "generateInner", async () => ((ran = true), { id: "rt-1" })],
    ]);
    await RedTeamSvc.runQueued("case-1", "user-1");
    expect(ran).to.equal(true);
    expect(summaries).to.have.length(0);
  });
});
