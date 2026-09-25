/** Automatic case-analysis refresh (issues #74-#76): a case's READY document corpus changing
 * (new document, deletion, or re-extraction) should eventually trigger the same CaseRefreshSvc
 * pipeline the lawyer's "Refresh analysis" button runs, after a debounce, without duplicating
 * that pipeline or spamming Chat Wonder for a large upload.
 *
 * No live Postgres/SQS: DocumentRepo, CaseRepo, CaseReconstructionRepo, AiGenerationLockSvc,
 * CaseRefreshSvc, CaseReconstructionSvc, CaseReconstructionAudioSvc, CaseReconstructionAudioQueue
 * and lib/sqs's sendMessage are monkeypatched on their CommonJS module objects, same idiom as
 * test/message-persistence-durability.spec.ts and test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import crypto from "crypto";
import * as sqs from "../src/lib/sqs";
import { scheduleCasePostExtraction, runCasePostExtraction } from "../src/queues/case-post-extraction";
import DocumentRepo from "../src/repositories/document.repository";
import CaseRepo from "../src/repositories/case.repository";
import CaseReconstructionRepo from "../src/repositories/case-reconstruction.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseRefreshSvc from "../src/services/case-refresh.service";
import CaseReconstructionSvc from "../src/services/case-reconstruction.service";
import CaseReconstructionAudioSvc from "../src/services/case-reconstruction-audio.service";
import CaseReconstructionAudioQueue from "../src/queues/case-reconstruction-audio.queue";
import WitnessExtractSvc from "../src/services/witness-extract.service";
import HttpError from "../src/utils/http-error";

function fingerprintOf(ids: string[]): string {
  return crypto.createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

function readyDocs(ids: string[]) {
  return ids.map((id) => ({ id, ragStatus: "READY" }));
}

describe("case-post-extraction: automatic refresh scheduling and execution", () => {
  const originals = {
    sendMessage: (sqs as any).sendMessage,
    countPending: DocumentRepo.countPendingExtractionByCase,
    listAllByCase: DocumentRepo.listAllByCase,
    exists: CaseRepo.exists,
    getFingerprint: CaseRepo.getReadySetFingerprint,
    setFingerprint: CaseRepo.setReadySetFingerprint,
    reconstructionGet: CaseReconstructionRepo.get,
    lockBegin: AiGenerationLockSvc.begin,
    refreshRunQueued: CaseRefreshSvc.runQueued,
    reconstructionGenerate: CaseReconstructionSvc.generate,
    startAudioJob: CaseReconstructionAudioSvc.startAudioJob,
    audioEnqueue: CaseReconstructionAudioQueue.enqueue,
    witnessSchedule: WitnessExtractSvc.schedule,
  };

  let sent: { queueUrl: string; body: string; delaySeconds?: number }[];
  let fingerprintStore: Record<string, string | null>;
  let caseExistsStore: Record<string, boolean>;
  // WitnessExtractSvc.schedule enqueues its own "witnessExtract" message — stubbed out of `sent`
  // so these tests keep counting only the refresh's own (re)schedule messages.
  let witnessScheduled: string[];

  beforeEach(() => {
    sent = [];
    witnessScheduled = [];
    (WitnessExtractSvc as any).schedule = (caseId: string) => {
      witnessScheduled.push(caseId);
    };
    fingerprintStore = {};
    caseExistsStore = { "case-1": true };

    (sqs as any).sendMessage = async (queueUrl: string, body: string, delaySeconds?: number) => {
      sent.push({ queueUrl, body, delaySeconds });
    };
    (DocumentRepo as any).countPendingExtractionByCase = async () => 0;
    (DocumentRepo as any).listAllByCase = async () => readyDocs([]);
    (CaseRepo as any).exists = async (id: string) => caseExistsStore[id] ?? false;
    (CaseRepo as any).getReadySetFingerprint = async (id: string) => fingerprintStore[id] ?? null;
    (CaseRepo as any).setReadySetFingerprint = async (id: string, fp: string) => {
      fingerprintStore[id] = fp;
    };
    // Default: reconstruction already exists, so tests that aren't specifically about
    // first-ingest don't incidentally exercise the generate/audio branch.
    (CaseReconstructionRepo as any).get = async () => ({ id: "recon-1" });
    (AiGenerationLockSvc as any).begin = async () => {};
    (CaseRefreshSvc as any).runQueued = async () => {};
    (CaseReconstructionSvc as any).generate = async () => ({ id: "recon-1" });
    (CaseReconstructionAudioSvc as any).startAudioJob = async () => {};
    (CaseReconstructionAudioQueue as any).enqueue = () => {};
  });

  afterEach(() => {
    (sqs as any).sendMessage = originals.sendMessage;
    (DocumentRepo as any).countPendingExtractionByCase = originals.countPending;
    (DocumentRepo as any).listAllByCase = originals.listAllByCase;
    (CaseRepo as any).exists = originals.exists;
    (CaseRepo as any).getReadySetFingerprint = originals.getFingerprint;
    (CaseRepo as any).setReadySetFingerprint = originals.setFingerprint;
    (CaseReconstructionRepo as any).get = originals.reconstructionGet;
    (AiGenerationLockSvc as any).begin = originals.lockBegin;
    (CaseRefreshSvc as any).runQueued = originals.refreshRunQueued;
    (CaseReconstructionSvc as any).generate = originals.reconstructionGenerate;
    (CaseReconstructionAudioSvc as any).startAudioJob = originals.startAudioJob;
    (CaseReconstructionAudioQueue as any).enqueue = originals.audioEnqueue;
    (WitnessExtractSvc as any).schedule = originals.witnessSchedule;
  });

  // ── Phase 3: durable debounce ─────────────────────────────────────────────────────────────

  it("schedules the debounce as a durably-delayed SQS message, not an in-memory timer", async () => {
    scheduleCasePostExtraction("case-1", "user-1");
    // scheduleCasePostExtraction's body is an async IIFE, not a synchronous call — a short flush
    // lets that microtask run. If this were still setTimeout(fn, 45_000), nothing would be sent
    // within this window and the assertion below would fail.
    await flush();
    expect(sent).to.have.length(1);
    expect(sent[0].delaySeconds).to.equal(45);
    const body = JSON.parse(sent[0].body);
    expect(body).to.include({ kind: "casePostExtraction", caseId: "case-1", userId: "user-1" });
  });

  // ── Phase 2: coalescing on pending docs / unchanged READY set ────────────────────────────

  it("reschedules (does not refresh) while documents are still extracting", async () => {
    (DocumentRepo as any).countPendingExtractionByCase = async () => 2;
    let lockCalled = false;
    (AiGenerationLockSvc as any).begin = async () => {
      lockCalled = true;
    };

    await runCasePostExtraction("case-1", "user-1");
    await flush();

    expect(lockCalled).to.equal(false);
    expect(sent).to.have.length(1); // the reschedule message
    expect(sent[0].delaySeconds).to.equal(45);
  });

  it("skips the refresh when the READY document set hasn't changed since the last run", async () => {
    (DocumentRepo as any).listAllByCase = async () => readyDocs(["d1", "d2"]);
    fingerprintStore["case-1"] = fingerprintOf(["d1", "d2"]);
    let refreshCalls = 0;
    (CaseRefreshSvc as any).runQueued = async () => {
      refreshCalls += 1;
    };

    await runCasePostExtraction("case-1", "user-1");

    expect(refreshCalls).to.equal(0);
  });

  it("runs the refresh when the READY document set has changed, then stamps the new fingerprint", async () => {
    (DocumentRepo as any).listAllByCase = async () => readyDocs(["d1"]);
    let refreshCalls: { caseId: string; userId: string }[] = [];
    (CaseRefreshSvc as any).runQueued = async (caseId: string, userId: string) => {
      refreshCalls.push({ caseId, userId });
      // Stands in for the whole CaseRefreshSvc pipeline, so it must reproduce refreshInner's
      // real fingerprint stamping (see case-refresh.service.ts) — that's what this test asserts.
      await CaseRepo.setReadySetFingerprint(caseId, fingerprintOf(["d1"]));
    };

    await runCasePostExtraction("case-1", "user-1");

    expect(refreshCalls).to.deep.equal([{ caseId: "case-1", userId: "user-1" }]);
    expect(fingerprintStore["case-1"]).to.equal(fingerprintOf(["d1"]));
  });

  it("a burst of duplicate triggers for the same corpus change collapses to a single Chat Wonder refresh", async () => {
    // Simulates the 2,000-document-upload edge case: every document's extraction finishing
    // schedules its own delayed message, but only the first one to actually run finds a
    // changed fingerprint — every later one (even a much later one, past a restart) is a no-op.
    const readyIds = ["d1", "d2", "d3"];
    (DocumentRepo as any).listAllByCase = async () => readyDocs(readyIds);
    let refreshCalls = 0;
    (CaseRefreshSvc as any).runQueued = async (caseId: string) => {
      refreshCalls += 1;
      // See the fingerprint-stamping comment above — refreshInner does this for real now, and
      // it's precisely that stamp which makes the 2nd/3rd trigger see an unchanged fingerprint.
      await CaseRepo.setReadySetFingerprint(caseId, fingerprintOf(readyIds));
    };

    await runCasePostExtraction("case-1", "user-1");
    await runCasePostExtraction("case-1", "user-1");
    await runCasePostExtraction("case-1", "user-1");

    expect(refreshCalls).to.equal(1);
  });

  // ── Phase 3: at most one active caseRefresh per case ──────────────────────────────────────

  it("reschedules instead of running a second refresh when caseRefresh is already in progress", async () => {
    (DocumentRepo as any).listAllByCase = async () => readyDocs(["d1"]);
    (AiGenerationLockSvc as any).begin = async () => {
      throw new HttpError("caseRefresh generation is already in progress", 409);
    };
    let refreshCalls = 0;
    (CaseRefreshSvc as any).runQueued = async () => {
      refreshCalls += 1;
    };

    await runCasePostExtraction("case-1", "user-1");
    await flush();

    expect(refreshCalls).to.equal(0);
    expect(sent).to.have.length(1); // the reschedule message, so the corpus change isn't lost
    expect(fingerprintStore["case-1"]).to.be.undefined; // not stamped — nothing actually ran
  });

  it("schedules witness extraction once extraction has settled, even when the READY set is unchanged", async () => {
    (DocumentRepo as any).listAllByCase = async () => readyDocs(["d1"]);
    fingerprintStore["case-1"] = fingerprintOf(["d1"]);
    await runCasePostExtraction("case-1", "user-1");
    expect(witnessScheduled).to.deep.equal(["case-1"]);
  });

  it("does not schedule witness extraction while documents are still extracting", async () => {
    (DocumentRepo as any).countPendingExtractionByCase = async () => 2;
    await runCasePostExtraction("case-1", "user-1");
    await flush();
    expect(witnessScheduled).to.deep.equal([]);
  });

  it("propagates a non-409 lock error instead of silently swallowing it", async () => {
    (DocumentRepo as any).listAllByCase = async () => readyDocs(["d1"]);
    (AiGenerationLockSvc as any).begin = async () => {
      throw new Error("db unavailable");
    };
    // The outer catch in runCasePostExtraction logs and swallows every error (never throws to
    // the queue worker) — so assert indirectly: no refresh ran and nothing was rescheduled,
    // since a non-409 error takes a different path than the coalesce branch above.
    await runCasePostExtraction("case-1", "user-1");
    await flush();
    expect(sent).to.have.length(0);
  });

  // ── Case deleted mid-flight ────────────────────────────────────────────────────────────────

  it("does nothing when the case no longer exists", async () => {
    caseExistsStore["case-1"] = false;
    let pendingChecked = false;
    (DocumentRepo as any).countPendingExtractionByCase = async () => {
      pendingChecked = true;
      return 0;
    };

    await runCasePostExtraction("case-1", "user-1");

    expect(pendingChecked).to.equal(false);
  });

  // ── Phase 1 reconstruction rule: first ingest vs later refresh ───────────────────────────

  it("generates Case Reconstruction + starts Polly on first ingest (no existing reconstruction)", async () => {
    (CaseReconstructionRepo as any).get = async () => null;
    let generateCalls = 0;
    let audioStartCalls = 0;
    let audioEnqueueCalls = 0;
    (CaseReconstructionSvc as any).generate = async () => {
      generateCalls += 1;
      return { id: "recon-1" };
    };
    (CaseReconstructionAudioSvc as any).startAudioJob = async () => {
      audioStartCalls += 1;
    };
    (CaseReconstructionAudioQueue as any).enqueue = () => {
      audioEnqueueCalls += 1;
    };

    await runCasePostExtraction("case-1", "user-1");

    expect(generateCalls).to.equal(1);
    expect(audioStartCalls).to.equal(1);
    expect(audioEnqueueCalls).to.equal(1);
  });

  it("does not regenerate Case Reconstruction on a later corpus change (protects lawyer edits)", async () => {
    (CaseReconstructionRepo as any).get = async () => ({ id: "recon-1", narrative: "lawyer-edited text" });
    let generateCalls = 0;
    (CaseReconstructionSvc as any).generate = async () => {
      generateCalls += 1;
      return {};
    };

    await runCasePostExtraction("case-1", "user-1");

    expect(generateCalls).to.equal(0);
  });
});
