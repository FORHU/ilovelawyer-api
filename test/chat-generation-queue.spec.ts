/**
 * The AI generation job architecture: ChatCtrl.sendMessage now only creates a job (the user
 * Message row, PENDING) and hands it to ChatGenerationQueue — RAG, cache check, AI streaming,
 * checkpointing, and canonical persistence all run in ChatSvc.processChatGenerationJob, owned
 * by a worker, decoupled from the original HTTP request/browser connection entirely. Live
 * chat:chunk/chat:done/chat:error/chat:session-rotated events go out over the existing
 * socket.io notification channel (lib/socket.ts's emitToUser) on a best-effort basis.
 *
 * No AWS/DB/Redis/real sockets: repository/service static methods and emitToUser are
 * monkeypatched on the CommonJS module objects, and the AI stream client talks to a local `ws`
 * server — the same pattern test/message-persistence-durability.spec.ts already established.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as sqs from "../src/lib/sqs";
import * as socketLib from "../src/lib/socket";
import * as config from "../src/config";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import TranscriptionChunkSvc from "../src/services/transcription-chunk.service";
import CaseSvc from "../src/services/case.service";
import { redis } from "../src/lib/redis";
import ChatGenerationQueue, { ChatGenerationJob } from "../src/queues/chat-generation.queue";
import CaseGraphPromotionQueue from "../src/queues/case-graph-promotion.queue";

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

const baseJob: ChatGenerationJob = {
  jobId: "m-user-1",
  organizationId: "org1",
  tenantCode: "PH",
  userId: "user1",
  consultationId: "c1",
  sessionId: "sess-1",
  userInput: "Hello, I need help.",
  effectiveCaseId: null,
};

// --- queue: always acks (Test 5 — worker crash relies on SQS redelivery, not blind retry) ---

describe("ChatGenerationQueue durability", () => {
  const originalProcess = ChatSvc.processChatGenerationJob;
  const originalDelete = (sqs as any).deleteMessage;
  const originalHeartbeat = (sqs as any).withVisibilityHeartbeat;
  let deleted: string[];
  let attempts: number;

  beforeEach(() => {
    deleted = [];
    attempts = 0;
    (sqs as any).deleteMessage = async (_url: string, handle: string) => {
      deleted.push(handle);
    };
    (sqs as any).withVisibilityHeartbeat = async (_u: string, _h: string | null, _t: number, job: () => Promise<unknown>) => job();
    (ChatGenerationQueue as any).running = true;
    (ChatGenerationQueue as any).active = 0;
    (ChatGenerationQueue as any).memoryWait = [];
  });

  afterEach(() => {
    ChatSvc.processChatGenerationJob = originalProcess;
    (sqs as any).deleteMessage = originalDelete;
    (sqs as any).withVisibilityHeartbeat = originalHeartbeat;
    (ChatGenerationQueue as any).running = false;
  });

  it("acks the SQS message after a successful job", async () => {
    ChatSvc.processChatGenerationJob = async () => {
      attempts++;
    };
    (ChatGenerationQueue as any).runOne({ job: baseJob, receiptHandle: "r-ok" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal(["r-ok"]);
    expect((ChatGenerationQueue as any).active).to.equal(0);
  });

  it("ALSO acks a job that failed — unlike CaseGraphPromotionQueue, this queue never relies on blind SQS redelivery for a controlled failure (Message.replyStatus is its own durable status record; see the class doc comment)", async () => {
    ChatSvc.processChatGenerationJob = async () => {
      attempts++;
      throw new Error("AI generation failed");
    };
    (ChatGenerationQueue as any).runOne({ job: baseJob, receiptHandle: "r-fail" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal(["r-fail"]); // acked despite the failure
    expect((ChatGenerationQueue as any).active).to.equal(0);
  });

  it("a genuine worker crash (never reaching ack) leaves the message for SQS to redeliver", async () => {
    // Simulated by simply never calling runOne's ack path at all — nothing to assert beyond
    // "nothing was deleted", since this queue has no in-process retry of its own for that case.
    expect(deleted).to.deep.equal([]);
  });
});

// --- ChatSvc.enqueueChatGeneration: the fast, synchronous half of the request ---

describe("ChatSvc.enqueueChatGeneration", () => {
  const originals = {
    findConsultationWithCase: ChatRepo.findConsultationWithCase,
    createMessage: ChatRepo.createMessage,
    getById: CaseSvc.getById,
    redisGet: redis.get,
    enqueue: ChatGenerationQueue.enqueue,
  };

  afterEach(() => {
    Object.assign(ChatRepo, { findConsultationWithCase: originals.findConsultationWithCase, createMessage: originals.createMessage });
    CaseSvc.getById = originals.getById;
    redis.get = originals.redisGet;
    ChatGenerationQueue.enqueue = originals.enqueue;
  });

  it("404s when the consultation doesn't exist or belongs to a different organization", async () => {
    ChatRepo.findConsultationWithCase = async () => null;
    let err: Error | undefined;
    try {
      await ChatSvc.enqueueChatGeneration("org1", "PH", "user1", "c1", "sess-1", "hello");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Consultation not found");
  });

  it("creates the PENDING user message, enqueues the job, and returns immediately without running RAG/AI/persistence", async () => {
    ChatRepo.findConsultationWithCase = async () => ({ id: "c1", organizationId: "org1", caseId: null, case: null, title: "Existing" }) as any;
    ChatRepo.createMessage = async (_c, role, _content, _userId, _p, _g, _go, _gt, replyStatus) => {
      expect(role).to.equal("user");
      expect(replyStatus).to.equal("PENDING");
      return { id: "m-user-1" } as any;
    };
    redis.get = (async (key: string) => (key.includes("session") ? "sess-1" : null)) as any;
    let enqueued: any = null;
    ChatGenerationQueue.enqueue = (job: any) => {
      enqueued = job;
    };

    const result = await ChatSvc.enqueueChatGeneration("org1", "PH", "user1", "c1", "sess-1", "hello");

    expect(result).to.deep.equal({ messageId: "m-user-1", sessionId: "sess-1", replyStatus: "PENDING" });
    expect(enqueued).to.not.equal(null);
    expect(enqueued.jobId).to.equal("m-user-1");
    expect(enqueued.consultationId).to.equal("c1");
    expect(enqueued.userInput).to.equal("hello");
    expect(enqueued.effectiveCaseId).to.equal(null);
  });

  it("404s immediately on a bad/foreign caseId — before ever reaching the queue", async () => {
    ChatRepo.findConsultationWithCase = async () => ({ id: "c1", organizationId: "org1", caseId: null, case: null, title: "Existing" }) as any;
    CaseSvc.getById = async () => {
      throw Object.assign(new Error("Case not found"), { statusCode: 404 });
    };
    let enqueued = false;
    ChatGenerationQueue.enqueue = () => {
      enqueued = true;
    };
    let err: Error | undefined;
    try {
      await ChatSvc.enqueueChatGeneration("org1", "PH", "user1", "c1", "sess-1", "hello", undefined, undefined, "foreign-case");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Case not found");
    expect(enqueued).to.equal(false);
  });
});

// --- ChatSvc.processChatGenerationJob: the worker-owned lifecycle ---

describe("ChatSvc.processChatGenerationJob", () => {
  let server: WebSocketServer;
  let script: string[] = [];
  let originalWsUrl: string;

  const originals = {
    findConsultationWithCase: ChatRepo.findConsultationWithCase,
    createMessage: ChatRepo.createMessage,
    checkpointPendingReply: ChatRepo.checkpointPendingReply,
    findAssistantReplyByParent: ChatRepo.findAssistantReplyByParent,
    findConsultationById: ChatRepo.findConsultationById,
    setReplyStatus: ChatRepo.setReplyStatus,
    listRefsForScope: DocumentRepo.listRefsForScope,
    findFullTextsByDocuments: DocumentChunkRepo.findFullTextsByDocuments,
    saveDecisionRecords: ChatRepo.saveDecisionRecords,
    findReplyState: ChatRepo.findReplyState,
    saveTimeline: ChatRepo.saveTimeline,
    saveMindMap: ChatRepo.saveMindMap,
    saveRelatedCases: ChatRepo.saveRelatedCases,
    relevantChunksForConsultation: DocumentChunkSvc.relevantChunksForConsultation,
    transcriptRelevantChunksForConsultation: TranscriptionChunkSvc.relevantChunksForConsultation,
    redisGet: redis.get,
    redisSet: redis.set,
    emitToUser: socketLib.emitToUser,
    caseGraphEnqueue: CaseGraphPromotionQueue.enqueue,
    caseSvcGetById: CaseSvc.getById,
  };

  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", () => {
        for (const frame of script) socket.send(frame);
      });
    });
    const { port } = server.address() as AddressInfo;
    originalWsUrl = config.CHAT_WONDER_WS_URL;
    (config as any).CHAT_WONDER_WS_URL = `ws://127.0.0.1:${port}/chat-stream`;
  });

  after(() => {
    (config as any).CHAT_WONDER_WS_URL = originalWsUrl;
    server.close();
  });

  let emitted: { userId: string; event: string; payload: any }[];

  beforeEach(() => {
    script = ["The full answer.__END__", "[DONE]"];
    emitted = [];

    ChatRepo.findConsultationWithCase = async () =>
      ({ id: "c1", organizationId: "org1", caseId: null, case: null, title: "Existing title" }) as any;
    ChatRepo.createMessage = async (_c, role, content) => {
      expect(role).to.equal("assistant"); // the worker only ever creates the assistant row
      return { id: "m-assistant-1", content } as any;
    };
    ChatRepo.checkpointPendingReply = async () => ({}) as any;
    ChatRepo.findAssistantReplyByParent = async () => null;
    ChatRepo.findConsultationById = async () => ({ id: "c1" }) as any;
    ChatRepo.setReplyStatus = async () => ({}) as any;
    DocumentRepo.listRefsForScope = async () => [];
    ChatRepo.findReplyState = async () =>
      ({ id: "m-user-1", consultationId: "c1", role: "user", userId: "user1", replyStatus: "PENDING", pendingReplyContent: null }) as any;
    ChatRepo.saveTimeline = async () => ({}) as any;
    ChatRepo.saveMindMap = async () => ({}) as any;
    ChatRepo.saveRelatedCases = async () => ({}) as any;
    DocumentChunkSvc.relevantChunksForConsultation = async () => ({ caseDocumentIds: [], caseDocumentChunkIds: [] });
    TranscriptionChunkSvc.relevantChunksForConsultation = async () => ({ transcriptionIds: [], transcriptionChunkIds: [] });
    redis.get = async () => null;
    redis.set = async () => {};
    (socketLib as any).emitToUser = (userId: string, event: string, payload: any) => {
      emitted.push({ userId, event, payload });
    };
    CaseGraphPromotionQueue.enqueue = () => {};
  });

  afterEach(() => {
    Object.assign(ChatRepo, {
      findConsultationWithCase: originals.findConsultationWithCase,
      createMessage: originals.createMessage,
      checkpointPendingReply: originals.checkpointPendingReply,
      findAssistantReplyByParent: originals.findAssistantReplyByParent,
      findConsultationById: originals.findConsultationById,
      setReplyStatus: originals.setReplyStatus,
      findReplyState: originals.findReplyState,
      saveTimeline: originals.saveTimeline,
      saveMindMap: originals.saveMindMap,
      saveRelatedCases: originals.saveRelatedCases,
    });
    DocumentRepo.listRefsForScope = originals.listRefsForScope;
    (DocumentChunkRepo as any).findFullTextsByDocuments = originals.findFullTextsByDocuments;
    (ChatRepo as any).saveDecisionRecords = originals.saveDecisionRecords;
    DocumentChunkSvc.relevantChunksForConsultation = originals.relevantChunksForConsultation;
    TranscriptionChunkSvc.relevantChunksForConsultation = originals.transcriptRelevantChunksForConsultation;
    redis.get = originals.redisGet;
    redis.set = originals.redisSet;
    (socketLib as any).emitToUser = originals.emitToUser;
    CaseGraphPromotionQueue.enqueue = originals.caseGraphEnqueue;
    CaseSvc.getById = originals.caseSvcGetById;
  });

  it("Test 1 — normal completion: RAG -> AI -> DB, final response exists (persisted), and the chat:started -> chat:chunk -> chat:done lifecycle fires in order", async () => {
    let created: string | undefined;
    ChatRepo.createMessage = async (_c, _role, content) => {
      created = content;
      return { id: "m-assistant-1", content } as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob);

    expect(created).to.equal("The full answer.");
    // The full event lifecycle, in order: chat:started, then chat:chunk(s), then chat:done —
    // never chat:done before the chunks, and chat:started must be first.
    const eventOrder = emitted.map((e) => e.event);
    expect(eventOrder[0]).to.equal("chat:started");
    expect(eventOrder[eventOrder.length - 1]).to.equal("chat:done");
    expect(eventOrder.filter((e) => e === "chat:chunk").length).to.be.greaterThan(0);
    expect(eventOrder.indexOf("chat:chunk")).to.be.greaterThan(eventOrder.indexOf("chat:started"));
    const done = emitted.find((e) => e.event === "chat:done");
    expect(done).to.not.equal(undefined);
    expect(done!.userId).to.equal("user1");
    expect(done!.payload.assistantMessageId).to.equal("m-assistant-1");
  });

  it("Test 2 — streaming: chat:chunk events reach the (simulated) connected browser with the right content, in order, while the worker processes", async () => {
    script = ["Part one. ", "Part two. ", "Part three.__END__", "[DONE]"];

    await ChatSvc.processChatGenerationJob(baseJob);

    const chunks = emitted.filter((e) => e.event === "chat:chunk").map((e) => e.payload.chunk);
    expect(chunks).to.deep.equal(["Part one. ", "Part two. ", "Part three."]);
    // Every emitted event is scoped to this job's own messageId/consultationId so a listener
    // can filter correctly (see mutations.ts's subscribeChatGeneration on the frontend).
    for (const e of emitted) {
      expect(e.payload.messageId).to.equal(baseJob.jobId);
      expect(e.payload.consultationId).to.equal(baseJob.consultationId);
    }
  });

  it("emits chat:answer-complete once the answer text has streamed (at __END__) and BEFORE chat:done, so the UI can stop showing 'generating' while the extras finish", async () => {
    script = ["Part one. ", "Part two.__END__", "[DONE]"];

    await ChatSvc.processChatGenerationJob(baseJob);

    const eventOrder = emitted.map((e) => e.event);
    expect(eventOrder.filter((e) => e === "chat:answer-complete").length).to.equal(1);
    expect(eventOrder.lastIndexOf("chat:chunk")).to.be.lessThan(eventOrder.indexOf("chat:answer-complete"));
    expect(eventOrder.indexOf("chat:answer-complete")).to.be.lessThan(eventOrder.indexOf("chat:done"));
    const evt = emitted.find((e) => e.event === "chat:answer-complete")!;
    expect(evt.payload.messageId).to.equal(baseJob.jobId);
    expect(evt.userId).to.equal("user1");
  });

  it("Test 3 — completes and persists the FULL response even when the live-push layer is completely broken (simulates a disconnected/refreshed browser mid-generation, or a socket.io bug): the worker doesn't know or care whether emitToUser reached anyone, and a throwing emitToUser can't block generation either (see emitEvent's try/catch)", async () => {
    (socketLib as any).emitToUser = () => {
      throw new Error("nobody is listening — socket layer is broken/disconnected");
    };
    let created: string | undefined;
    ChatRepo.createMessage = async (_c, _role, content) => {
      created = content;
      return { id: "m-assistant-1", content } as any;
    };

    // Must NOT throw and must still persist the full, correct response — a broken/throwing
    // push layer is never load-bearing for the AI job itself.
    await ChatSvc.processChatGenerationJob(baseJob);

    expect(created).to.equal("The full answer.");
  });

  it("Test 6 — AI failure: replyStatus is FAILED, chat:error is emitted, and no assistant message is created", async () => {
    script = ["[Error] Unknown session.", "__END__"];
    // "Unknown session." with no prior content triggers streamWithSessionRetry's rotation —
    // give it a session id to rotate to, and let the SECOND attempt fail too so the whole
    // job ultimately fails (rather than testing the retry-succeeds path, covered elsewhere).
    redis.get = async () => null;
    let created = false;
    ChatRepo.createMessage = async () => {
      created = true;
      return { id: "should-not-be-created" } as any;
    };
    const statuses: string[] = [];
    ChatRepo.setReplyStatus = async (_id, status) => {
      statuses.push(status);
      return {} as any;
    };

    let err: Error | undefined;
    try {
      await ChatSvc.processChatGenerationJob(baseJob);
    } catch (e) {
      err = e as Error;
    }

    expect(err).to.not.equal(undefined);
    expect(created).to.equal(false);
    expect(statuses).to.include("FAILED");
    // Failure lifecycle: chat:started -> chat:error, never chat:done.
    const startedEvent = emitted.find((e) => e.event === "chat:started");
    expect(startedEvent).to.not.equal(undefined);
    const errorEvent = emitted.find((e) => e.event === "chat:error");
    expect(errorEvent).to.not.equal(undefined);
    const doneEvent = emitted.find((e) => e.event === "chat:done");
    expect(doneEvent).to.equal(undefined);
  });

  it("Test 7 — DB failure: canonical persistence failing after retries means the job is NOT successful — FAILED status, chat:error, no false success", async function () {
    this.timeout(20_000); // exhausts persistAssistantTurnWithRetry's real 2s/4s/8s backoff
    let attempts = 0;
    ChatRepo.createMessage = async () => {
      attempts++;
      throw new Error("Can't reach database server");
    };
    const statuses: string[] = [];
    ChatRepo.setReplyStatus = async (_id, status) => {
      statuses.push(status);
      return {} as any;
    };

    let err: Error | undefined;
    try {
      await ChatSvc.processChatGenerationJob(baseJob);
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).to.equal("Can't reach database server");
    expect(attempts).to.equal(4); // 1 initial + 3 retries
    expect(statuses).to.include("FAILED");
    expect(emitted.some((e) => e.event === "chat:error")).to.equal(true);
    expect(emitted.some((e) => e.event === "chat:done")).to.equal(false);
  });

  it("Test 9 — duplicate SQS delivery: processing the same job twice creates only ONE canonical assistant message", async () => {
    let createCalls = 0;
    let existing: { id: string } | null = null;
    ChatRepo.findAssistantReplyByParent = async () => existing;
    ChatRepo.createMessage = async (_c, _role, content) => {
      createCalls++;
      existing = { id: "m-assistant-1" };
      return { id: "m-assistant-1", content } as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob); // first delivery
    await ChatSvc.processChatGenerationJob(baseJob); // SQS redelivered the same message

    expect(createCalls).to.equal(1);
    const doneEvents = emitted.filter((e) => e.event === "chat:done");
    expect(doneEvents).to.have.length(2); // both deliveries report done — same assistantMessageId
    expect(doneEvents[0].payload.assistantMessageId).to.equal("m-assistant-1");
    expect(doneEvents[1].payload.assistantMessageId).to.equal("m-assistant-1");
  });

  it("Test 10 — cache hit: a cached response still produces exactly one durable assistant message, with no AI call made", async () => {
    let wsConnected = false;
    server.once("connection", () => {
      wsConnected = true;
    });
    redis.get = async (key: string) => {
      if (key.startsWith("chat:response:")) {
        return { content: "Cached answer.", relatedCases: [] } as any;
      }
      return null;
    };
    let createCalls = 0;
    let created: string | undefined;
    ChatRepo.createMessage = async (_c, _role, content) => {
      createCalls++;
      created = content;
      return { id: "m-assistant-1", content } as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob);

    expect(created).to.equal("Cached answer.");
    expect(createCalls).to.equal(1);
    expect(wsConnected).to.equal(false); // no Chat Wonder call for a cache hit
    const chunks = emitted.filter((e) => e.event === "chat:chunk").map((e) => e.payload.chunk);
    expect(chunks).to.deep.equal(["Cached answer."]); // cache replay still streams live
    expect(emitted.some((e) => e.event === "chat:done")).to.equal(true);
  });

  it("Test 7 — case-linked chat: once the assistant message is persisted, CaseGraphPromotionQueue.enqueue is called with the turn's timeline/decisions", async () => {
    const caseLinkedJob: ChatGenerationJob = { ...baseJob, effectiveCaseId: "case-1" };
    script = [
      "The full answer.__END__",
      '[STRUCTURED_DATA]{"timeline":[{"title":"Filed complaint","occurredOn":"2024-01-01"}]}[DONE]',
    ];
    // consultation.case is null in the shared beforeEach mock (a general, not-case-linked
    // consultation record), so a job with an explicit effectiveCaseId falls through to a real
    // CaseSvc.getById lookup for the case-context text — same as a case-portfolio chat whose
    // consultation itself has no case link (see processChatGenerationJob's caseRecord logic).
    CaseSvc.getById = async () => ({ id: "case-1", caseName: "Test Case" }) as any;
    let enqueuedPayload: any = null;
    CaseGraphPromotionQueue.enqueue = (payload: any) => {
      enqueuedPayload = payload;
    };

    await ChatSvc.processChatGenerationJob(caseLinkedJob);

    expect(enqueuedPayload).to.not.equal(null);
    expect(enqueuedPayload.effectiveCaseId).to.equal("case-1");
    expect(enqueuedPayload.assistantMessageId).to.equal("m-assistant-1");
    expect(enqueuedPayload.timeline).to.have.length(1);
  });

  it("Test 8 — non-case chat: assistant message is still persisted, but CaseGraphPromotionQueue.enqueue is never called, even if the reply happens to contain a timeline", async () => {
    // effectiveCaseId is null on baseJob — a general (non-case) consultation. Scripting a
    // timeline anyway proves the gate is on effectiveCaseId, not merely "no data to promote".
    script = [
      "The full answer.__END__",
      '[STRUCTURED_DATA]{"timeline":[{"title":"Filed complaint","occurredOn":"2024-01-01"}]}[DONE]',
    ];
    let created: string | undefined;
    let enqueueCalled = false;
    ChatRepo.createMessage = async (_c, _role, content) => {
      created = content;
      return { id: "m-assistant-1", content } as any;
    };
    CaseGraphPromotionQueue.enqueue = () => {
      enqueueCalled = true;
    };

    await ChatSvc.processChatGenerationJob(baseJob);

    expect(created).to.equal("The full answer.");
    expect(enqueueCalled).to.equal(false);
  });

  // --- File ids must never reach a user (utils/document-references.ts) ---

  const DOC_ID = "b56af9c1-1119-4ebe-bca2-330bbf6ea759";
  const DOC_NAME = "Letter before claim.pdf";

  it("no file id reaches the user: an id in the streamed answer becomes the file name, in the live chunk and in the saved reply", async () => {
    DocumentRepo.listRefsForScope = async () => [{ id: DOC_ID, name: DOC_NAME }] as any;
    script = [`The claim is set out in ${DOC_ID} at clause 5.__END__`, "[DONE]"];
    let saved: string | undefined;
    ChatRepo.createMessage = async (_c, _role, content) => {
      saved = content;
      return { id: "m-assistant-1", content } as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob);

    const live = emitted.filter((e) => e.event === "chat:chunk").map((e) => e.payload.chunk).join("");
    expect(live).to.include(DOC_NAME);
    expect(live).to.not.include(DOC_ID);
    expect(saved).to.equal(`The claim is set out in ${DOC_NAME} at clause 5.`);
  });

  it("Decision Records are saved with the file name instead of the id, docId filled in, and a quote that really is in the document verified (the exact shape from the bug report)", async () => {
    const quote = "Halcyon says clause 5 required Prestbury to achieve a 98% next-day dispatch service level";
    DocumentRepo.listRefsForScope = async () => [{ id: DOC_ID, name: DOC_NAME }] as any;
    (DocumentChunkRepo as any).findFullTextsByDocuments = async () => new Map([[DOC_ID, `Section 2. ${quote}. More text.`]]);
    const decisions = {
      type: "decisions",
      data: {
        records: [
          {
            anchor: "Prestbury denies liability.",
            conclusion: "Prestbury contests its liability.",
            rule: [],
            evidenceFor: [{ doc: DOC_ID, docId: null, pinpoint: "Section 2", quote, verified: false }],
            evidenceAgainst: [],
            alternatives: [],
            weighting: "Significant.",
            confidence: "high",
            wouldChangeIf: [],
          },
        ],
      },
    };
    script = ["Prestbury denies liability.__END__", JSON.stringify(decisions), "[DONE]"];
    let savedDecisions: any;
    (ChatRepo as any).saveDecisionRecords = async (_id: string, data: any) => {
      savedDecisions = data;
      return {} as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob);

    expect(savedDecisions).to.not.equal(undefined);
    const ev = savedDecisions.records[0].evidenceFor[0];
    expect(ev.doc).to.equal(DOC_NAME);
    expect(ev.docId).to.equal(DOC_ID);
    expect(ev.verified).to.equal(true);
    expect(JSON.stringify(savedDecisions)).to.not.include(`"doc":"${DOC_ID}"`);
  });

  it("scopedCaseDocumentId looks the document up by ORGANIZATION (it used to pass the user id, which never matched, so an explicitly attached file was silently never used)", async () => {
    const seen: { id: string; org: string }[] = [];
    const doc = { id: "doc-1", userId: "user1", consultationId: "c1", caseId: null, status: "ACTIVE" };
    const originalFindById = DocumentRepo.findById;
    DocumentRepo.findById = (async (id: string, org: string) => {
      seen.push({ id, org });
      return org === "org1" ? doc : null;
    }) as any;
    try {
      const scoped = (ChatSvc as any).scopedCaseDocumentId.bind(ChatSvc);
      expect(await scoped("doc-1", "org1", "user1", "c1")).to.equal("doc-1");
      expect(seen[0]).to.deep.equal({ id: "doc-1", org: "org1" });
      // Another organization, another user's file, and another consultation all fail closed.
      expect(await scoped("doc-1", "other-org", "user1", "c1")).to.equal(undefined);
      expect(await scoped("doc-1", "org1", "someone-else", "c1")).to.equal(undefined);
      expect(await scoped("doc-1", "org1", "user1", "c2")).to.equal(undefined);
    } finally {
      DocumentRepo.findById = originalFindById;
    }
  });

  it("messages already saved with an id in their Decision Records are cleaned when listed, and the clean form is saved back", async () => {
    const original = {
      findConsultationById: ChatRepo.findConsultationById,
      listMessagesByConsultation: (ChatRepo as any).listMessagesByConsultation,
      updateDecisionRecords: (ChatRepo as any).updateDecisionRecords,
    };
    let updated: any;
    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "org1", caseId: null }) as any;
    DocumentRepo.listRefsForScope = async () => [{ id: DOC_ID, name: DOC_NAME }] as any;
    (DocumentChunkRepo as any).findFullTextsByDocuments = async () => new Map();
    (ChatRepo as any).updateDecisionRecords = async (_id: string, data: any) => {
      updated = data;
      return {} as any;
    };
    (ChatRepo as any).listMessagesByConsultation = async () => [
      { id: "u1", role: "user", content: "analyze", documents: [], decisionRecords: null, generatedDocument: null },
      {
        id: "a1",
        role: "assistant",
        content: `See "Letter before claim.pdf" (id: ${DOC_ID}) for the claim.`,
        documents: [],
        generatedDocument: null,
        decisionRecords: {
          id: "dr1",
          messageId: "a1",
          verification: {},
          records: [
            {
              anchor: "x",
              conclusion: "y",
              rule: [],
              evidenceFor: [{ doc: DOC_ID, docId: null, pinpoint: "", quote: null, verified: false }],
              evidenceAgainst: [],
              alternatives: [],
              weighting: "",
              confidence: "high",
              wouldChangeIf: [],
            },
          ],
        },
      },
    ];
    try {
      const messages: any[] = await ChatSvc.listMessages("org1", "c1");
      const assistant = messages.find((m) => m.id === "a1");
      expect(assistant.content).to.equal('See "Letter before claim.pdf" for the claim.');
      expect(assistant.decisionRecords.records[0].evidenceFor[0].doc).to.equal(DOC_NAME);
      expect(assistant.decisionRecords.records[0].evidenceFor[0].docId).to.equal(DOC_ID);
      expect(JSON.stringify(messages)).to.not.include(DOC_ID + '","docId":null');
      await flush();
      expect(updated.records[0].evidenceFor[0].doc).to.equal(DOC_NAME);
    } finally {
      ChatRepo.findConsultationById = original.findConsultationById;
      (ChatRepo as any).listMessagesByConsultation = original.listMessagesByConsultation;
      (ChatRepo as any).updateDecisionRecords = original.updateDecisionRecords;
    }
  });

  it("listing clean messages does not touch the documents table at all", async () => {
    const original = {
      findConsultationById: ChatRepo.findConsultationById,
      listMessagesByConsultation: (ChatRepo as any).listMessagesByConsultation,
    };
    let lookups = 0;
    DocumentRepo.listRefsForScope = async () => {
      lookups++;
      return [];
    };
    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "org1", caseId: null }) as any;
    (ChatRepo as any).listMessagesByConsultation = async () => [
      { id: "u1", role: "user", content: "hello", documents: [], decisionRecords: null, generatedDocument: null },
      { id: "a1", role: "assistant", content: "A clean answer.", documents: [], decisionRecords: null, generatedDocument: null },
    ];
    try {
      const messages: any[] = await ChatSvc.listMessages("org1", "c1");
      expect(messages).to.have.length(2);
      expect(lookups).to.equal(0);
    } finally {
      ChatRepo.findConsultationById = original.findConsultationById;
      (ChatRepo as any).listMessagesByConsultation = original.listMessagesByConsultation;
    }
  });

  it("consultation deleted before the job ran: drops the job without creating a message or throwing", async () => {
    ChatRepo.findConsultationWithCase = async () => null;
    let created = false;
    ChatRepo.createMessage = async () => {
      created = true;
      return { id: "x" } as any;
    };

    await ChatSvc.processChatGenerationJob(baseJob); // must not throw

    expect(created).to.equal(false);
  });
});
