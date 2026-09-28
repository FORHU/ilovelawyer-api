/** CaseFindingAiSvc.scheduleIfOutdated: opening the Terminal on a case whose findings predate
 * FINDINGS_FORMAT_VERSION queues one findings-only regeneration. No live Postgres or SQS — repos,
 * the lock and the queue are monkeypatched, same idiom as contradiction-triage.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import DocumentRepo from "../src/repositories/document.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import HttpError from "../src/utils/http-error";
import { FINDINGS_FORMAT_VERSION } from "../src/constants";

describe("CaseFindingAiSvc.scheduleIfOutdated", () => {
  const originals = {
    findJob: AiGenerationJobRepo.findBySubjectAndKind,
    listDocs: DocumentRepo.listAllByCase,
    begin: AiGenerationLockSvc.begin,
    enqueue: AiGenerationQueue.enqueue,
  };
  let job: unknown;
  let docs: { ragStatus: string }[];
  let begun: string[];
  let enqueued: unknown[];
  let beginError: Error | null;

  beforeEach(() => {
    job = null;
    docs = [{ ragStatus: "READY" }];
    begun = [];
    enqueued = [];
    beginError = null;
    (AiGenerationJobRepo as any).findBySubjectAndKind = async () => job;
    (DocumentRepo as any).listAllByCase = async () => docs;
    (AiGenerationLockSvc as any).begin = async (caseId: string, kind: string) => {
      if (beginError) throw beginError;
      begun.push(`${caseId}:${kind}`);
    };
    (AiGenerationQueue as any).enqueue = (j: unknown) => enqueued.push(j);
  });
  afterEach(() => {
    (AiGenerationJobRepo as any).findBySubjectAndKind = originals.findJob;
    (DocumentRepo as any).listAllByCase = originals.listDocs;
    (AiGenerationLockSvc as any).begin = originals.begin;
    (AiGenerationQueue as any).enqueue = originals.enqueue;
  });

  const caseRow = (findingsFormatVersion: number | null) => ({ id: "case-1", userId: "owner-1", findingsFormatVersion });

  it("does nothing for a case already on the current format", async () => {
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(FINDINGS_FORMAT_VERSION));
    expect(begun).to.deep.equal([]);
    expect(enqueued).to.deep.equal([]);
  });

  it("claims the lock and queues one regeneration for an unstamped or older case", async () => {
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(null));
    expect(begun).to.deep.equal(["case-1:caseFinding"]);
    expect(enqueued).to.deep.equal([{ kind: "caseFinding", caseId: "case-1", userId: "owner-1" }]);
  });

  it("doesn't queue again while a run holds the lock", async () => {
    beginError = new HttpError("already running", 409);
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(1));
    expect(enqueued).to.deep.equal([]);
  });

  it("skips a case with no READY documents", async () => {
    docs = [{ ragStatus: "PENDING" }];
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(null));
    expect(begun).to.deep.equal([]);
  });

  it("doesn't retry within an hour of a failed run, but does after", async () => {
    job = { status: "FAILED", finishedAt: new Date(Date.now() - 10 * 60 * 1000) };
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(null));
    expect(enqueued).to.have.length(0);

    job = { status: "FAILED", finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(null));
    expect(enqueued).to.have.length(1);
  });

  it("never throws, even when a lookup fails", async () => {
    (DocumentRepo as any).listAllByCase = async () => {
      throw new Error("db down");
    };
    await CaseFindingAiSvc.scheduleIfOutdated(caseRow(null));
    expect(enqueued).to.deep.equal([]);
  });
});
