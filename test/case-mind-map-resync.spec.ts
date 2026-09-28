/** CaseMindMapSvc.scheduleResync/runResync: a document change that finds a map build already
 * running queues ONE retry for after it, however many changes land meanwhile. Redis, the queue and
 * the build itself are stubbed; no live services. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { redis } from "../src/lib/redis";
import CaseRepo from "../src/repositories/case.repository";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import CaseMindMapSvc, { CASE_MIND_MAP_RESYNC_DELAY_SECONDS } from "../src/services/case-mind-map.service";
import HttpError from "../src/utils/http-error";

const busy = () => new HttpError("caseMindMap generation is already in progress", 409);

describe("case mind map resync after a busy build (coalesced)", () => {
  const originals = {
    setIfAbsent: redis.setIfAbsent,
    del: redis.del,
    enqueue: AiGenerationQueue.enqueue,
    exists: CaseRepo.exists,
    generate: CaseMindMapSvc.generateFromDocuments,
  };
  // A fake Redis: `null` in place of the store means "not reachable".
  let store: Set<string> | null;
  let queued: { kind: string; caseId: string; delaySeconds?: number }[];
  let builds: (string | undefined)[];
  let buildResults: (Error | null)[];

  beforeEach(() => {
    store = new Set();
    queued = [];
    builds = [];
    buildResults = [];
    (redis as any).setIfAbsent = async (key: string) => {
      if (!store) return null;
      if (store.has(key)) return false;
      store.add(key);
      return true;
    };
    (redis as any).del = async (key: string) => void store?.delete(key);
    (AiGenerationQueue as any).enqueue = (job: { kind: string; caseId: string }, delaySeconds?: number) =>
      void queued.push({ kind: job.kind, caseId: job.caseId, delaySeconds });
    (CaseRepo as any).exists = async () => true;
    (CaseMindMapSvc as any).generateFromDocuments = async (_caseId: string, _userId: string, reason?: string) => {
      builds.push(reason);
      const next = buildResults.shift();
      if (next) throw next;
      return { skipped: null, map: null };
    };
  });

  afterEach(() => {
    (redis as any).setIfAbsent = originals.setIfAbsent;
    (redis as any).del = originals.del;
    (AiGenerationQueue as any).enqueue = originals.enqueue;
    (CaseRepo as any).exists = originals.exists;
    (CaseMindMapSvc as any).generateFromDocuments = originals.generate;
  });

  it("queues one delayed retry for any number of changes while a build runs", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await CaseMindMapSvc.scheduleResync("case-1", "user-1"));
    expect(results).to.deep.equal([true, false, false, false, false]);
    expect(queued).to.deep.equal([{ kind: "caseMindMapResync", caseId: "case-1", delaySeconds: CASE_MIND_MAP_RESYNC_DELAY_SECONDS }]);
  });

  it("coalesces per case, not across cases", async () => {
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    await CaseMindMapSvc.scheduleResync("case-2", "user-1");
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    expect(queued.map((q) => q.caseId)).to.deep.equal(["case-1", "case-2"]);
  });

  it("the retry runs an automatic build, so a map someone expanded or edited is still left alone", async () => {
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    await CaseMindMapSvc.runResync("case-1", "user-1");
    expect(builds).to.deep.equal(["auto"]);
  });

  it("clears the flag when the retry runs, so a later change queues a fresh retry", async () => {
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    await CaseMindMapSvc.runResync("case-1", "user-1");
    expect(await CaseMindMapSvc.scheduleResync("case-1", "user-1")).to.equal(true);
    expect(queued).to.have.length(2);
  });

  it("queues exactly one next retry when the lock is still busy, even with changes queued meanwhile", async () => {
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    buildResults = [busy()];
    await CaseMindMapSvc.runResync("case-1", "user-1");
    // Another change hits the same busy build after the retry re-queued.
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    expect(queued).to.have.length(2);
  });

  it("doesn't retry a build that failed for another reason", async () => {
    await CaseMindMapSvc.scheduleResync("case-1", "user-1");
    buildResults = [new Error("chat-wonder timeout")];
    await CaseMindMapSvc.runResync("case-1", "user-1");
    expect(queued).to.have.length(1);
  });

  it("skips a case deleted before the retry ran", async () => {
    (CaseRepo as any).exists = async () => false;
    await CaseMindMapSvc.runResync("case-1", "user-1");
    expect(builds).to.deep.equal([]);
  });

  it("still queues the retry when Redis can't be reached", async () => {
    store = null;
    expect(await CaseMindMapSvc.scheduleResync("case-1", "user-1")).to.equal(true);
    expect(queued).to.have.length(1);
  });
});
