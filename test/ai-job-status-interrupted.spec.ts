/** The status the panels poll closes out a run the server never finished (it restarted mid-run),
 * so a panel doesn't show "updating" forever. Repository and access check are monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import CaseAccess from "../src/utils/case-access";
import { STALE_AFTER_MS } from "../src/constants";

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
});
