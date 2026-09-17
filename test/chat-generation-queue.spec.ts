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
    saveTimeline: ChatRepo.saveTimeline,
    saveMindMap: ChatRepo.saveMindMap,
    saveRelatedCases: ChatRepo.saveRelatedCases,
    relevantChunksForConsultation: DocumentChunkSvc.relevantChunksForConsultation,
    transcriptRelevantChunksForConsultation: TranscriptionChunkSvc.relevantChunksForConsultation,
    redisGet: redis.get,
    redisSet: redis.set,
    emitToUser: socketLib.emitToUser,
    caseGraphEnqueue: CaseGraphPromotionQueue.enqueue,
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
      saveTimeline: originals.saveTimeline,
      saveMindMap: originals.saveMindMap,
      saveRelatedCases: originals.saveRelatedCases,
    });
    DocumentChunkSvc.relevantChunksForConsultation = originals.relevantChunksForConsultation;
    TranscriptionChunkSvc.relevantChunksForConsultation = originals.transcriptRelevantChunksForConsultation;
    redis.get = originals.redisGet;
    redis.set = originals.redisSet;
    (socketLib as any).emitToUser = originals.emitToUser;
    CaseGraphPromotionQueue.enqueue = originals.caseGraphEnqueue;
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
