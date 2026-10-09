/** The backstop behind the route guards: the workers that run every AI job refuse to run one for
 * someone who has switched AI processing off - including jobs no button starts (automatic
 * analysis, witness/damages extraction, map resync) and jobs queued before they withdrew.
 * No live Postgres/SQS: collaborators are monkeypatched on their CommonJS module objects, same
 * idiom as test/case-post-extraction.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AiGenerationQueue from "../src/queues/ai-generation.queue";
import ConsentSvc from "../src/services/consent.service";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import CaseRefreshSvc from "../src/services/case-refresh.service";
import WitnessExtractSvc from "../src/services/witness-extract.service";
import DamagesExtractSvc from "../src/services/damages-extract.service";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";

describe("AiGenerationQueue worker and AI processing consent", () => {
  const originals = {
    isAllowed: ConsentSvc.isAllowed,
    refresh: CaseRefreshSvc.runQueued,
    witness: WitnessExtractSvc.runQueued,
    damages: DamagesExtractSvc.runQueued,
    resync: CaseMindMapSvc.runResync,
    finding: CaseFindingAiSvc.runQueued,
  };
  let allowed: boolean;
  let checkedFor: string[];
  let ran: string[];

  beforeEach(() => {
    allowed = true;
    checkedFor = [];
    ran = [];
    (ConsentSvc as any).isAllowed = async (userId: string, purpose: string) => {
      checkedFor.push(`${userId}:${purpose}`);
      return allowed;
    };
    (CaseRefreshSvc as any).runQueued = async () => void ran.push("caseRefresh");
    (WitnessExtractSvc as any).runQueued = async () => void ran.push("witnessExtract");
    (DamagesExtractSvc as any).runQueued = async () => void ran.push("damagesExtract");
    (CaseMindMapSvc as any).runResync = async () => void ran.push("caseMindMapResync");
    (CaseFindingAiSvc as any).runQueued = async () => void ran.push("caseFinding");
  });

  afterEach(() => {
    (ConsentSvc as any).isAllowed = originals.isAllowed;
    (CaseRefreshSvc as any).runQueued = originals.refresh;
    (WitnessExtractSvc as any).runQueued = originals.witness;
    (DamagesExtractSvc as any).runQueued = originals.damages;
    (CaseMindMapSvc as any).runResync = originals.resync;
    (CaseFindingAiSvc as any).runQueued = originals.finding;
  });

  // runOne is private and fire-and-forget; give its promise chain a few ticks to settle.
  const run = async (kind: string) => {
    (AiGenerationQueue as any).runOne({ job: { kind, caseId: "case-1", userId: "user-1" }, receiptHandle: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  // Includes the four that no route starts: they are enqueued by services.
  const KINDS = ["caseRefresh", "witnessExtract", "damagesExtract", "caseMindMapResync", "caseFinding"];

  for (const kind of KINDS) {
    it(`runs ${kind} when AI processing is allowed`, async () => {
      await run(kind);
      expect(ran).to.deep.equal([kind]);
      expect(checkedFor).to.deep.equal(["user-1:AI_PROCESSING"]);
    });

    it(`does not run ${kind} once AI processing is withdrawn`, async () => {
      allowed = false;
      await run(kind);
      expect(ran).to.deep.equal([]);
      expect(checkedFor).to.deep.equal(["user-1:AI_PROCESSING"]);
    });
  }
});

describe("ChatSvc.processChatGenerationJob and AI processing consent", () => {
  const originals = {
    isAllowed: ConsentSvc.isAllowed,
    setReplyStatus: ChatRepo.setReplyStatus,
    runChat: (ChatSvc as any).runChatGenerationJob,
  };
  let allowed: boolean;
  let statuses: Array<[string, string]>;
  let generated: number;

  beforeEach(() => {
    allowed = true;
    statuses = [];
    generated = 0;
    (ConsentSvc as any).isAllowed = async () => allowed;
    (ChatRepo as any).setReplyStatus = async (id: string, status: string) => void statuses.push([id, status]);
    (ChatSvc as any).runChatGenerationJob = async () => void (generated += 1);
  });

  afterEach(() => {
    (ConsentSvc as any).isAllowed = originals.isAllowed;
    (ChatRepo as any).setReplyStatus = originals.setReplyStatus;
    (ChatSvc as any).runChatGenerationJob = originals.runChat;
  });

  const job = { jobId: "m-1", organizationId: "o-1", userId: "user-1", consultationId: "c-1" } as any;

  it("generates a reply when AI processing is allowed", async () => {
    await ChatSvc.processChatGenerationJob(job);
    expect(generated).to.equal(1);
    expect(statuses).to.deep.equal([]);
  });

  it("fails a queued turn without calling the AI once AI processing is withdrawn, so the page stops waiting", async () => {
    allowed = false;
    await ChatSvc.processChatGenerationJob(job);
    expect(generated).to.equal(0);
    expect(statuses).to.deep.equal([["m-1", "FAILED"]]);
  });
});
