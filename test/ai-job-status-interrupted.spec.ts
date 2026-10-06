/** The status the panels poll closes out a run the server never finished (it restarted mid-run),
 * so a panel doesn't show "updating" forever. Repository and access check are monkeypatched. */
import { expect } from "chai";
import { Prisma } from "@prisma/client";
import { describe, it, beforeEach, afterEach } from "mocha";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import CaseAccess from "../src/utils/case-access";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_AFTER_MS, STALE_AFTER_MS } from "../src/constants";

describe("AiGenerationLockSvc.getStatusForCase", () => {
  let restore: (() => void)[];
  let row: Record<string, any> | null;
  let finished: { status: string; error?: string }[];

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  beforeEach(() => {
    restore = [];
    finished = [];
    patch(CaseAccess, "loadAccessibleCase", async () => ({ id: "case-1" }));
    patch(AiGenerationJobRepo, "findBySubjectAndKind", async () => (row ? { ...row } : null));
    patch(AiGenerationJobRepo, "updateStatus", async (_s: string, _k: string, status: string, error?: string) => {
      finished.push({ status, error });
      row = { ...row, status, error, finishedAt: new Date() };
      return row;
    });
    patch(AiGenerationLockSvc as any, "emit", () => {});
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("reports a run that stopped long ago as failed, so the panel offers a retry", async () => {
    row = { subjectId: "case-1", kind: "timelineGenerate", status: "IN_PROGRESS", startedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000) };
    const status = await AiGenerationLockSvc.getStatusForCase("case-1", "u1", "timelineGenerate");
    expect(status).to.include({ status: "FAILED" });
    expect(finished).to.have.length(1);
  });

  it("leaves a run that is still within its time alone", async () => {
    row = { subjectId: "case-1", kind: "timelineGenerate", status: "IN_PROGRESS", startedAt: new Date(Date.now() - 60_000) };
    const status = await AiGenerationLockSvc.getStatusForCase("case-1", "u1", "timelineGenerate");
    expect(status).to.include({ status: "IN_PROGRESS" });
    expect(finished).to.deep.equal([]);
  });

  it("leaves a long analysis refresh alone while its heartbeat is fresh", async () => {
    row = { subjectId: "case-1", kind: "caseRefresh", status: "IN_PROGRESS", startedAt: new Date(Date.now() - 40 * 60_000), heartbeatAt: new Date(Date.now() - 20_000) };
    const status = await AiGenerationLockSvc.getStatusForCase("case-1", "u1", "caseRefresh");
    expect(status).to.include({ status: "IN_PROGRESS" });
    expect(finished).to.deep.equal([]);
  });

  it("closes a run whose heartbeat went silent — the API restarted mid-run — so the header doesn't stay on", async () => {
    row = { subjectId: "case-1", kind: "caseRefresh", status: "IN_PROGRESS", startedAt: new Date(Date.now() - 5 * 60_000), heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_AFTER_MS - 10_000) };
    const status = await AiGenerationLockSvc.getStatusForCase("case-1", "u1", "caseRefresh");
    expect(status).to.include({ status: "FAILED" });
  });

  it("refuses a second run while the first one's heartbeat is fresh, and reclaims the lock once it has gone silent", async () => {
    patch(AiGenerationJobRepo, "create", async () => {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    });
    let reclaimed = 0;
    patch(AiGenerationJobRepo, "markInProgress", async () => (reclaimed++, { ...row, status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: null }));

    row = { subjectId: "case-1", kind: "caseRefresh", status: "IN_PROGRESS", startedAt: new Date(Date.now() - 30 * 60_000), heartbeatAt: new Date(Date.now() - 10_000) };
    let error: any;
    await AiGenerationLockSvc.begin("case-1", "caseRefresh").catch((err) => (error = err));
    expect(error?.statusCode).to.equal(409);

    row = { ...row, heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_AFTER_MS - 10_000) };
    await AiGenerationLockSvc.begin("case-1", "caseRefresh");
    expect(reclaimed).to.equal(1);
  });

  it("stamps the heartbeat while the work runs and stops once it has finished", async () => {
    const beats: number[] = [];
    patch(AiGenerationJobRepo, "touchHeartbeat", async () => void beats.push(Date.now()));
    row = { subjectId: "case-1", kind: "caseRefresh", status: "IN_PROGRESS", startedAt: new Date() };
    await AiGenerationLockSvc.finishWith("case-1", "caseRefresh", async () => "ok");
    const afterFinish = beats.length;
    expect(afterFinish).to.equal(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(beats.length).to.equal(afterFinish);
    expect(HEARTBEAT_INTERVAL_MS).to.be.lessThan(HEARTBEAT_STALE_AFTER_MS / 2);
  });
});
