/** ClientOverviewSvc (ilovelawyer-client#45 / ilovelawyer-api#572): the Overview tab's generate
 * job. The read side has its own spec (client-case-overview.spec.ts). No live Postgres: repositories are monkeypatched on their CommonJS module objects, same
 * idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientOverviewSvc from "../src/services/client-overview.service";
import ClientCaseOverviewSvc from "../src/services/client-case-overview.service";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import CaseRepo from "../src/repositories/case.repository";
import ClientOverviewRepo from "../src/repositories/client-overview.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import MissingEvidenceRepo from "../src/repositories/missing-evidence.repository";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import CaseStrategySvc from "../src/services/case-strategy.service";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";
import MissingEvidenceAiSvc from "../src/services/missing-evidence-ai.service";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import { CLIENT_OVERVIEW_AI_BUDGET_USD, CLIENT_OVERVIEW_DAILY_CAP } from "../src/config";
import type { ClientWorkspace } from "../src/services/client-case.service";

/** Saves `keys` on `target` for the root afterEach to put back — every stub, whichever describe
 * made it, so none leaks into another spec file. */
const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const workspace: ClientWorkspace = { id: "org-1", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "case-1";
const caseRow = { id: CASE_ID } as any;

/** What ClientCaseOverviewSvc.get returns in these tests — beginQueued hands back the read side's
 * DTO, whose own content is covered by client-case-overview.spec.ts. */
const READ_DTO = { fromReadSide: true } as any;

describe("ClientOverviewSvc", () => {
  beforeEach(() => {
    stash(ClientCaseRepo, ["findById"]);
    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (id === CASE_ID && orgId === workspace.id ? caseRow : null);
  });
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("ownership", () => {
    it("404s for a case not in this client's workspace, before claiming anything", async () => {
      expect((await errorOf(ClientOverviewSvc.beginQueued(workspace, "u1", "someone-elses-case")))?.status).to.equal(404);
    });
  });

  describe("beginQueued — two quick requests start one job", () => {
    beforeEach(() => {
      stash(LlmUsageRepo, ["sumCostUsd"]);
      stash(ClientOverviewRepo, ["claimDailyRun", "find"]);
      stash(AiGenerationLockSvc, ["getStatus", "begin"]);
      stash(AiGenerationQueue, ["enqueue"]);
      stash(ClientCaseOverviewSvc, ["get"]);
      (LlmUsageRepo as any).sumCostUsd = async () => 0;
      (ClientOverviewRepo as any).find = async () => null;
      (AiGenerationQueue as any).enqueue = () => {};
      (ClientCaseOverviewSvc as any).get = async () => READ_DTO;
    });

    it("claims the daily cap and the lock exactly once when nothing is running yet", async () => {
      let claims = 0;
      (AiGenerationLockSvc as any).getStatus = async () => null;
      (ClientOverviewRepo as any).claimDailyRun = async () => (++claims, { leftToday: CLIENT_OVERVIEW_DAILY_CAP - 1 });
      let begins = 0;
      (AiGenerationLockSvc as any).begin = async () => {
        begins++;
      };
      expect(await ClientOverviewSvc.beginQueued(workspace, "u1", CASE_ID)).to.equal(READ_DTO);
      expect(claims).to.equal(1);
      expect(begins).to.equal(1);
    });

    it("a second request while one is already running returns the same state without claiming a second run", async () => {
      (AiGenerationLockSvc as any).getStatus = async () => ({ status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date() });
      let claims = 0;
      (ClientOverviewRepo as any).claimDailyRun = async () => {
        claims++;
        return { leftToday: 0 };
      };
      expect(await ClientOverviewSvc.beginQueued(workspace, "u1", CASE_ID)).to.equal(READ_DTO);
      expect(claims).to.equal(0);
    });

    it("refuses with 402 once the case's AI budget for the overview is spent", async () => {
      (AiGenerationLockSvc as any).getStatus = async () => null;
      (LlmUsageRepo as any).sumCostUsd = async () => CLIENT_OVERVIEW_AI_BUDGET_USD;
      const error = await errorOf(ClientOverviewSvc.beginQueued(workspace, "u1", CASE_ID));
      expect(error?.status).to.equal(402);
      expect(error?.code).to.equal("OVERVIEW_BUDGET_REACHED");
    });

    it("refuses with 429 once today's cap is used", async () => {
      (AiGenerationLockSvc as any).getStatus = async () => null;
      (ClientOverviewRepo as any).claimDailyRun = async () => null;
      const error = await errorOf(ClientOverviewSvc.beginQueued(workspace, "u1", CASE_ID));
      expect(error?.status).to.equal(429);
      expect(error?.code).to.equal("OVERVIEW_DAILY_LIMIT");
    });
  });

  describe("beginAuto — the first-document trigger", () => {
    beforeEach(() => {
      stash(ClientOverviewRepo, ["find", "claimDailyRun"]);
      stash(LlmUsageRepo, ["sumCostUsd"]);
      stash(AiGenerationLockSvc, ["begin"]);
      (LlmUsageRepo as any).sumCostUsd = async () => 0;
      (AiGenerationLockSvc as any).begin = async () => {};
    });

    it("runs once, the first time, when nothing has ever been generated", async () => {
      (ClientOverviewRepo as any).find = async () => null;
      let claimed = false;
      (ClientOverviewRepo as any).claimDailyRun = async () => {
        claimed = true;
        return { leftToday: CLIENT_OVERVIEW_DAILY_CAP - 1 };
      };
      expect(await ClientOverviewSvc.beginAuto(CASE_ID)).to.equal(true);
      expect(claimed).to.equal(true);
    });

    it("never runs again once an overview has already been generated — a later upload only goes STALE, read live by get()", async () => {
      (ClientOverviewRepo as any).find = async () => ({ generatedAt: new Date() });
      let claimed = false;
      (ClientOverviewRepo as any).claimDailyRun = async () => {
        claimed = true;
        return { leftToday: 1 };
      };
      expect(await ClientOverviewSvc.beginAuto(CASE_ID)).to.equal(false);
      expect(claimed).to.equal(false);
    });
  });

  describe("generateInner (via runQueued)", () => {
    beforeEach(() => {
      stash(DocumentRepo, ["listAllByCase"]);
      stash(CaseStrategySvc, ["generateFromDocuments"]);
      stash(CaseFindingAiSvc, ["generateFromDocuments"]);
      stash(MissingEvidenceAiSvc, ["generateFromDocuments"]);
      stash(CaseTimelineRepo, ["list"]);
      stash(CaseFindingRepo, ["list"]);
      stash(MissingEvidenceRepo, ["list"]);
      stash(ClientOverviewRepo, ["saveResult"]);
      stash(AiGenerationJobRepo, ["create", "updateStatus", "touchHeartbeat"]);
      stash(CaseChangeSummaryRepo, ["create", "latestRefresh"]);
      stash(CaseRepo, ["getLastRefreshedAt"]);
      (DocumentRepo as any).listAllByCase = async () => [{ id: "d1", name: "Contract.pdf", ragStatus: "READY", status: "ACTIVE" }];
      (CaseChangeSummaryRepo as any).create = async () => {};
      (CaseChangeSummaryRepo as any).latestRefresh = async () => null;
      (CaseRepo as any).getLastRefreshedAt = async () => null;
      (CaseTimelineRepo as any).list = async () => [];
      (CaseFindingRepo as any).list = async () => [];
      (MissingEvidenceRepo as any).list = async () => [];
      (AiGenerationJobRepo as any).create = async () => ({ status: "IN_PROGRESS", startedAt: new Date(), finishedAt: null, error: null });
      (AiGenerationJobRepo as any).updateStatus = async (_s: string, _k: string, status: string, error?: string) => ({
        status,
        startedAt: new Date(),
        finishedAt: new Date(),
        error: error ?? null,
      });
      (AiGenerationJobRepo as any).touchHeartbeat = async () => {};
    });

    it("saves content when at least one pane succeeds, even if the others fail", async () => {
      (CaseStrategySvc as any).generateFromDocuments = async () => {
        throw new Error("boom");
      };
      (CaseFindingAiSvc as any).generateFromDocuments = async () => {};
      (MissingEvidenceAiSvc as any).generateFromDocuments = async () => {};
      let saved: any;
      (ClientOverviewRepo as any).saveResult = async (_caseId: string, data: unknown) => {
        saved = data;
      };
      await ClientOverviewSvc.runQueued(CASE_ID, "u1");
      expect(saved.panes).to.deep.equal({ strategy: "FAILED", findings: "DONE", missingEvidence: "DONE" });
    });

    it("saves the run's change summary after its content, with the run's reason and documents", async () => {
      (CaseStrategySvc as any).generateFromDocuments = async () => {};
      (CaseFindingAiSvc as any).generateFromDocuments = async () => {};
      (MissingEvidenceAiSvc as any).generateFromDocuments = async () => {};
      const order: string[] = [];
      let summary: any;
      (ClientOverviewRepo as any).saveResult = async () => {
        order.push("content");
      };
      (CaseChangeSummaryRepo as any).create = async (data: unknown) => {
        order.push("summary");
        summary = data;
      };
      await ClientOverviewSvc.runQueued(CASE_ID, "u1", "post-extraction");
      expect(order).to.deep.equal(["content", "summary"]);
      expect(summary).to.include({ caseId: CASE_ID, reason: "post-extraction", actorId: "u1" });
      expect(summary.readyDocumentIds).to.deep.equal(["d1"]);
    });

    it("fails the whole run when every pane fails", async () => {
      (CaseStrategySvc as any).generateFromDocuments = async () => {
        throw new Error("a");
      };
      (CaseFindingAiSvc as any).generateFromDocuments = async () => {
        throw new Error("b");
      };
      (MissingEvidenceAiSvc as any).generateFromDocuments = async () => {
        throw new Error("c");
      };
      (ClientOverviewRepo as any).saveResult = async () => {
        throw new Error("must not be called");
      };
      const error = await errorOf(ClientOverviewSvc.runQueued(CASE_ID, "u1"));
      expect(error?.code).to.equal("OVERVIEW_GENERATION_FAILED");
    });
  });
});
