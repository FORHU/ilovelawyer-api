/** ClientIntakeSvc (docs/plans/client-side-compressed-meteor.md §3.1): GET/POST
 * /api/client/cases/:caseId/intake(/refresh), and the automatic trigger scheduleAuto. No live
 * Postgres: repositories/services are monkeypatched on their CommonJS module objects, same
 * idiom as test/client-case-overview.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientIntakeSvc, { fingerprintOf } from "../src/services/client-intake.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientIntakeRepo from "../src/repositories/client-intake.repository";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import ChatRepo from "../src/repositories/chat.repository";
import AiGenerationQueue from "../src/queues/ai-generation.queue";

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

let caseRow: any;
let intakeSource: any;

describe("ClientIntakeSvc", () => {
  beforeEach(() => {
    stash(ClientCaseRepo, ["findById"]);
    stash(ClientIntakeRepo, ["find", "findCaseForIntake", "claimDailyRun", "saveResult"]);
    stash(AiGenerationJobRepo, ["findBySubjectAndKind"]);
    stash(AiGenerationLockSvc, ["getStatus", "begin"]);
    stash(LlmUsageRepo, ["sumCostUsd"]);
    stash(ChatRepo, ["listMessagesByConsultation"]);
    stash(AiGenerationQueue, ["enqueue"]);

    caseRow = { id: CASE_ID, documents: [] };
    intakeSource = {
      id: CASE_ID,
      caseName: "Dismissal",
      caseAreas: ["EMPLOYMENT"],
      ukJurisdiction: "England and Wales",
      jurisdiction: "Leeds",
      clientSide: "CLAIMANT",
      notes: null,
      lawyerReadiness: null,
      parties: [],
      documents: [],
      consultationId: "c1",
    };

    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (id === CASE_ID && orgId === workspace.id ? caseRow : null);
    (ClientIntakeRepo as any).find = async () => null;
    (ClientIntakeRepo as any).findCaseForIntake = async () => intakeSource;
    (ClientIntakeRepo as any).claimDailyRun = async () => ({ leftToday: 4 });
    (ClientIntakeRepo as any).saveResult = async () => {};
    (AiGenerationJobRepo as any).findBySubjectAndKind = async () => null;
    (AiGenerationLockSvc as any).getStatus = async () => null;
    (AiGenerationLockSvc as any).begin = async () => {};
    (LlmUsageRepo as any).sumCostUsd = async () => 0;
    (ChatRepo as any).listMessagesByConsultation = async () => [];
    (AiGenerationQueue as any).enqueue = () => {};
  });

  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("ownership", () => {
    it("get() 404s for another client's case", async () => {
      expect((await errorOf(ClientIntakeSvc.get({ ...workspace, id: "org-2" }, CASE_ID)))?.status).to.equal(404);
    });

    it("beginQueued() 404s for another client's case", async () => {
      expect((await errorOf(ClientIntakeSvc.beginQueued({ ...workspace, id: "org-2" }, "user-1", CASE_ID)))?.status).to.equal(404);
    });
  });

  describe("get()", () => {
    it("is EMPTY with no run yet", async () => {
      const result = await ClientIntakeSvc.get(workspace, CASE_ID);
      expect(result.status).to.equal("EMPTY");
      expect(result.generatedAt).to.be.null;
      expect(result.people).to.deep.equal([]);
    });

    it("is RUNNING while a live job is in progress", async () => {
      (AiGenerationJobRepo as any).findBySubjectAndKind = async () => ({ status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date() });
      const result = await ClientIntakeSvc.get(workspace, CASE_ID);
      expect(result.status).to.equal("RUNNING");
      expect(result.updates.allowed).to.equal(false);
    });

    it("is READY with stored data matching the current fingerprint, STALE once it doesn't", async () => {
      const data = { generatedAt: "2026-10-20T00:00:00.000Z", summary: "s", people: [], timeline: [], facts: [], goals: [], concerns: [], questionsForLawyer: [], deadlines: [], missing: [], conflicts: [], completeness: null };
      const currentFp = await fingerprintOf(intakeSource, null);

      (ClientIntakeRepo as any).find = async () => ({ data, fingerprint: currentFp });
      let result = await ClientIntakeSvc.get(workspace, CASE_ID);
      expect(result.status).to.equal("READY");
      expect(result.summary).to.equal("s");

      (ClientIntakeRepo as any).find = async () => ({ data, fingerprint: "a-stale-fingerprint" });
      result = await ClientIntakeSvc.get(workspace, CASE_ID);
      expect(result.status).to.equal("STALE");
      // Stale content is still shown — never blanked out just because it's out of date.
      expect(result.summary).to.equal("s");
    });

    it("is FAILED, not EMPTY, when the last run failed", async () => {
      (AiGenerationJobRepo as any).findBySubjectAndKind = async () => ({ status: "FAILED", startedAt: new Date(), heartbeatAt: new Date() });
      const result = await ClientIntakeSvc.get(workspace, CASE_ID);
      expect(result.status).to.equal("FAILED");
    });
  });

  describe("beginQueued()", () => {
    it("refuses with 402 once the case's AI budget is used up", async () => {
      (LlmUsageRepo as any).sumCostUsd = async () => 1000;
      const err = await errorOf(ClientIntakeSvc.beginQueued(workspace, "user-1", CASE_ID));
      expect(err?.status).to.equal(402);
      expect(err?.code).to.equal("INTAKE_BUDGET_REACHED");
    });

    it("refuses with 429 once today's update cap is used", async () => {
      (ClientIntakeRepo as any).claimDailyRun = async () => null;
      const err = await errorOf(ClientIntakeSvc.beginQueued(workspace, "user-1", CASE_ID));
      expect(err?.status).to.equal(429);
      expect(err?.code).to.equal("INTAKE_DAILY_LIMIT");
    });

    it("enqueues a run and returns the current (still EMPTY) DTO", async () => {
      let enqueued: unknown;
      (AiGenerationQueue as any).enqueue = (job: unknown) => (enqueued = job);
      const result = await ClientIntakeSvc.beginQueued(workspace, "user-1", CASE_ID);
      expect(enqueued).to.deep.equal({ kind: "clientIntake", caseId: CASE_ID, userId: "user-1" });
      expect(result.status).to.equal("EMPTY");
    });

    it("returns the same running job instead of enqueueing twice", async () => {
      (AiGenerationLockSvc as any).getStatus = async () => ({ status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date() });
      let enqueueCount = 0;
      (AiGenerationQueue as any).enqueue = () => enqueueCount++;
      await ClientIntakeSvc.beginQueued(workspace, "user-1", CASE_ID);
      expect(enqueueCount).to.equal(0);
    });
  });

  describe("scheduleAuto()", () => {
    it("never throws, even when the case can't be found", async () => {
      (ClientIntakeRepo as any).findCaseForIntake = async () => null;
      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "chat");
    });

    it("skips the run when the stored fingerprint already matches this case's current one", async () => {
      const currentFp = await fingerprintOf(intakeSource, null);
      let enqueued = false;
      (AiGenerationQueue as any).enqueue = () => (enqueued = true);

      // Unchanged since the last run: nothing to do.
      (ClientIntakeRepo as any).find = async () => ({ fingerprint: currentFp });
      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "chat");
      expect(enqueued).to.equal(false);

      // The case changed (a different stored fingerprint, or no run yet): schedules one.
      (ClientIntakeRepo as any).find = async () => ({ fingerprint: "a-stale-fingerprint" });
      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "chat");
      expect(enqueued).to.equal(true);
    });

    it("skips once the case's AI budget is used up", async () => {
      (LlmUsageRepo as any).sumCostUsd = async () => 1000;
      let enqueued = false;
      (AiGenerationQueue as any).enqueue = () => (enqueued = true);
      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "document");
      expect(enqueued).to.equal(false);
    });

    it("does not count against the daily cap", async () => {
      let claimed = false;
      (ClientIntakeRepo as any).claimDailyRun = async () => {
        claimed = true;
        return { leftToday: 0 };
      };
      await ClientIntakeSvc.scheduleAuto(CASE_ID, "user-1", "chat");
      expect(claimed).to.equal(false);
    });
  });

  describe("the route", () => {
    let role: string;
    const getRoute = (as: string) => request(app).get(`/api/client/cases/${CASE_ID}/intake`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` });
    const postRoute = (as: string) => request(app).post(`/api/client/cases/${CASE_ID}/intake/refresh`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` });

    beforeEach(() => {
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      role = "USER";
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, id: userId === "other-client" ? "org-2" : workspace.id });
    });

    it("GET serves the client's own case", async () => {
      const res = await getRoute("client");
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal("EMPTY");
    });

    it("GET refuses a lawyer with 403 CLIENT_ACCOUNT_ONLY", async () => {
      role = "LAWYER";
      const res = await getRoute("lawyer");
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
    });

    it("GET 404s for another client", async () => {
      expect((await getRoute("other-client")).status).to.equal(404);
    });

    it("POST refresh enqueues a run and answers 202", async () => {
      const res = await postRoute("client");
      expect(res.status).to.equal(202);
      expect(res.body.status).to.equal("EMPTY");
    });
  });
});
