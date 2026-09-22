/**
 * AiGenerationLockSvc pushes live status over the existing socket.io notification channel
 * (lib/socket.ts's emitToCase) — ai-job:started / ai-job:done / ai-job:failed, to the case room
 * rather than a per-user room, since the lock is keyed on caseId+kind, not on who triggered it
 * (see the class's own emit() doc comment). Every one of AiGenerationQueue's 8 kinds funnels
 * through begin()/finish(), so these are the only two emit sites that need covering.
 *
 * No AWS/DB/real sockets: AiGenerationJobRepo and emitToCase are monkeypatched on the CommonJS
 * module objects, same pattern as document-extraction-socket.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { Prisma } from "@prisma/client";

import * as socketLib from "../src/lib/socket";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import { AI_GENERATION_KINDS } from "../src/constants/ai-generation-kinds";

interface Emitted {
  caseId: string;
  event: string;
  payload: any;
}

const CASE_ID = "case1";
const KIND = "caseRefresh" as const;

describe("AiGenerationLockSvc socket events", () => {
  const originals = {
    emitToCase: socketLib.emitToCase,
    findBySubjectAndKind: AiGenerationJobRepo.findBySubjectAndKind,
    create: AiGenerationJobRepo.create,
    markInProgress: AiGenerationJobRepo.markInProgress,
    updateStatus: AiGenerationJobRepo.updateStatus,
  };

  let emitted: Emitted[];
  let existingJob: { status: string; startedAt: Date } | null;

  beforeEach(() => {
    emitted = [];
    existingJob = null;

    (socketLib as any).emitToCase = (caseId: string, event: string, payload: any) => {
      emitted.push({ caseId, event, payload });
    };
    AiGenerationJobRepo.findBySubjectAndKind = (async () => existingJob) as any;
    AiGenerationJobRepo.create = (async (subjectId: string, kind: string) => ({
      subjectId,
      kind,
      status: "IN_PROGRESS",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: null,
      error: null,
    })) as any;
    AiGenerationJobRepo.markInProgress = (async (subjectId: string, kind: string) => ({
      subjectId,
      kind,
      status: "IN_PROGRESS",
      startedAt: new Date("2026-01-01T00:05:00.000Z"),
      finishedAt: null,
      error: null,
    })) as any;
    AiGenerationJobRepo.updateStatus = (async (subjectId: string, kind: string, status: string, error?: string) => ({
      subjectId,
      kind,
      status,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:10:00.000Z"),
      error: error ?? null,
    })) as any;
  });

  afterEach(() => {
    (socketLib as any).emitToCase = originals.emitToCase;
    AiGenerationJobRepo.findBySubjectAndKind = originals.findBySubjectAndKind;
    AiGenerationJobRepo.create = originals.create;
    AiGenerationJobRepo.markInProgress = originals.markInProgress;
    AiGenerationJobRepo.updateStatus = originals.updateStatus;
  });

  it("emits ai-job:started to the case room on a fresh claim (create succeeds)", async () => {
    await AiGenerationLockSvc.begin(CASE_ID, KIND);

    expect(emitted).to.have.length(1);
    expect(emitted[0].caseId).to.equal(CASE_ID);
    expect(emitted[0].event).to.equal("ai-job:started");
    expect(emitted[0].payload).to.include({ caseId: CASE_ID, kind: KIND, status: "IN_PROGRESS", finishedAt: null, error: null });
    expect(emitted[0].payload.startedAt).to.equal("2026-01-01T00:00:00.000Z");
  });

  it("emits ai-job:started on a stale-row reclaim (create throws P2002, existing row is stale)", async () => {
    AiGenerationJobRepo.create = (async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    }) as any;
    existingJob = { status: "DONE", startedAt: new Date("2020-01-01T00:00:00.000Z") };

    await AiGenerationLockSvc.begin(CASE_ID, KIND);

    expect(emitted.map((e) => e.event)).to.deep.equal(["ai-job:started"]);
    expect(emitted[0].payload.startedAt).to.equal("2026-01-01T00:05:00.000Z");
  });

  it("emits nothing when begin() is blocked by an already-IN_PROGRESS, non-stale job (409)", async () => {
    AiGenerationJobRepo.create = (async () => {
      throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    }) as any;
    existingJob = { status: "IN_PROGRESS", startedAt: new Date() };

    let threw = false;
    try {
      await AiGenerationLockSvc.begin(CASE_ID, KIND);
    } catch (err: any) {
      threw = true;
      expect(err.statusCode).to.equal(409);
    }

    expect(threw).to.equal(true);
    expect(emitted).to.have.length(0);
  });

  it("rethrows a non-unique-constraint error from create() without emitting", async () => {
    AiGenerationJobRepo.create = (async () => {
      throw new Error("connection lost");
    }) as any;

    let threw = false;
    try {
      await AiGenerationLockSvc.begin(CASE_ID, KIND);
    } catch {
      threw = true;
    }

    expect(threw).to.equal(true);
    expect(emitted).to.have.length(0);
  });

  it("emits ai-job:done with the row's startedAt/finishedAt on success", async () => {
    await AiGenerationLockSvc.finish(CASE_ID, KIND, "DONE");

    expect(emitted).to.have.length(1);
    expect(emitted[0].event).to.equal("ai-job:done");
    expect(emitted[0].payload).to.include({
      caseId: CASE_ID,
      kind: KIND,
      status: "DONE",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:10:00.000Z",
      error: null,
    });
  });

  it("emits ai-job:failed with the error message on failure", async () => {
    await AiGenerationLockSvc.finish(CASE_ID, KIND, "FAILED", "Chat Wonder timed out");

    expect(emitted).to.have.length(1);
    expect(emitted[0].event).to.equal("ai-job:failed");
    expect(emitted[0].payload.error).to.equal("Chat Wonder timed out");
  });

  it("finishWith emits ai-job:done for a successful fn and ai-job:failed for a throwing one, always rethrowing", async () => {
    const result = await AiGenerationLockSvc.finishWith(CASE_ID, KIND, async () => "ok");
    expect(result).to.equal("ok");
    expect(emitted.map((e) => e.event)).to.deep.equal(["ai-job:done"]);

    emitted = [];
    let threw = false;
    try {
      await AiGenerationLockSvc.finishWith(CASE_ID, KIND, async () => {
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(emitted.map((e) => e.event)).to.deep.equal(["ai-job:failed"]);
  });

  it("still resolves normally when the live-push layer throws — a broken socket never fails the lock", async () => {
    (socketLib as any).emitToCase = () => {
      throw new Error("socket layer is broken");
    };

    await AiGenerationLockSvc.begin(CASE_ID, KIND);
    await AiGenerationLockSvc.finish(CASE_ID, KIND, "DONE");
    // No throw above is the assertion — begin()/finish() must complete despite the broken emit.
  });

  it("covers every AiGenerationJob kind through the same two emit sites (no per-kind special-casing) — " +
    "note casePostExtraction isn't itself a lock kind: its runner claims the lock as \"caseRefresh\" " +
    "(case-post-extraction.ts), which is exactly the kind already covered here", async () => {
    for (const kind of AI_GENERATION_KINDS) {
      emitted = [];
      await AiGenerationLockSvc.begin(CASE_ID, kind);
      await AiGenerationLockSvc.finish(CASE_ID, kind, "DONE");
      expect(emitted.map((e) => e.event)).to.deep.equal(["ai-job:started", "ai-job:done"]);
      expect(emitted.every((e) => e.payload.kind === kind)).to.equal(true);
    }
  });
});
