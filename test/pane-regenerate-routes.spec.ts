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
    patch([[AiGenerationLockSvc, "finishWith", async (_c: string, kind: string, fn: () => Promise<unknown>) => (order.push(`lock:${kind}`), fn())]]);
  });

  afterEach(restoreAll);

  it("a findings category runs under its own kind", async () => {
    patch([[CaseFindingAiSvc as any, "generateFromDocumentsInner", async (_c: string, only: string) => void order.push(`findings:${only}`)]]);
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
