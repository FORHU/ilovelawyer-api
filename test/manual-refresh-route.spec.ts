/** The Terminal's "Refresh analysis" button: POST /:caseId/refresh claims the caseRefresh lock and
 * queues the run, returning the IN_PROGRESS job; a second click while that run is alive is refused
 * with a 409 instead of starting a duplicate. Repository, access check and queue are monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { Prisma } from "@prisma/client";
import CaseTerminalCtrl from "../src/controllers/case-terminal.controller";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import CaseAccess from "../src/utils/case-access";

describe("POST /:caseId/refresh (manual Refresh analysis)", () => {
  let restore: (() => void)[];
  let row: Record<string, any> | null;
  let queued: any[];

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  function response() {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (code: number) => ((res.statusCode = code), res);
    res.json = (body: unknown) => ((res.body = body), res);
    return res;
  }

  const req = { params: { caseId: "case-1" }, user: { userId: "user-1" } } as any;

  beforeEach(() => {
    restore = [];
    row = null;
    queued = [];
    patch(CaseAccess, "assertCanEdit", async () => ({ id: "case-1" }));
    patch(AiGenerationJobRepo, "findBySubjectAndKind", async () => (row ? { ...row } : null));
    patch(AiGenerationJobRepo, "create", async (subjectId: string, kind: string) => {
      if (row) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
      row = { subjectId, kind, status: "IN_PROGRESS", startedAt: new Date(), finishedAt: null, error: null, heartbeatAt: null };
      return row;
    });
    patch(AiGenerationQueue, "enqueue", (job: unknown) => void queued.push(job));
    patch(AiGenerationLockSvc as any, "emit", () => {});
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("queues a caseRefresh run and answers 202 with the IN_PROGRESS job", async () => {
    const res = response();
    await CaseTerminalCtrl.refresh(req, res);
    expect(res.statusCode).to.equal(202);
    expect(res.body).to.include({ kind: "caseRefresh", status: "IN_PROGRESS" });
    expect(queued).to.deep.equal([{ kind: "caseRefresh", caseId: "case-1", userId: "user-1" }]);
  });

  it("refuses a second click with 409 while the first run is alive, and queues nothing more", async () => {
    await CaseTerminalCtrl.refresh(req, response());
    row = { ...row, heartbeatAt: new Date() };
    let error: any;
    await CaseTerminalCtrl.refresh(req, response()).catch((err) => (error = err));
    expect(error?.statusCode).to.equal(409);
    expect(queued).to.have.length(1);
  });

  it("refuses a user who can't edit the case before touching the lock", async () => {
    patch(CaseAccess, "assertCanEdit", async () => {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    });
    let error: any;
    await CaseTerminalCtrl.refresh(req, response()).catch((err) => (error = err));
    expect(error?.statusCode).to.equal(403);
    expect(row).to.equal(null);
    expect(queued).to.deep.equal([]);
  });
});
