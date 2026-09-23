/**
 * The Stop button, API side: ChatSvc.cancelChatGeneration (the endpoint's logic) and the worker
 * (ChatSvc.processChatGenerationJob) noticing it and stopping — closing its Chat Wonder socket.
 *
 * Same no-AWS/DB/Redis pattern as test/chat-generation-queue.spec.ts: repository/service
 * statics and emitToUser are monkeypatched, and Chat Wonder is a local `ws` server that sends
 * a couple of chunks and then stays open (a turn that is still generating).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as socketLib from "../src/lib/socket";
import * as config from "../src/config";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import TranscriptionChunkSvc from "../src/services/transcription-chunk.service";
import { redis } from "../src/lib/redis";
import { ChatGenerationJob } from "../src/queues/chat-generation.queue";

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

describe("Stopping a generation", () => {
  let server: WebSocketServer;
  let script: string[] = [];
  let sockets: WebSocket[] = [];
  let originalWsUrl: string;

  const originals = {
    findConsultationWithCase: ChatRepo.findConsultationWithCase,
    createMessage: ChatRepo.createMessage,
    checkpointPendingReply: ChatRepo.checkpointPendingReply,
    findAssistantReplyByParent: ChatRepo.findAssistantReplyByParent,
    findConsultationById: ChatRepo.findConsultationById,
    setReplyStatus: ChatRepo.setReplyStatus,
    findReplyState: ChatRepo.findReplyState,
    markReplyCancelled: ChatRepo.markReplyCancelled,
    relevantChunksForConsultation: DocumentChunkSvc.relevantChunksForConsultation,
    transcriptRelevantChunksForConsultation: TranscriptionChunkSvc.relevantChunksForConsultation,
    redisGet: redis.get,
    redisSet: redis.set,
    emitToUser: socketLib.emitToUser,
  };

  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      sockets.push(socket);
      // Sends its frames and then just stays open — a turn that is still generating.
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
  let created: { content: string; parent?: string }[];
  let statuses: string[];
  let replyStatus: string;

  beforeEach(() => {
    script = ["Part one. ", "Part two. "];
    sockets = [];
    emitted = [];
    created = [];
    statuses = [];
    replyStatus = "PENDING";

    ChatRepo.findConsultationWithCase = async () =>
      ({ id: "c1", organizationId: "org1", caseId: null, case: null, title: "Existing title" }) as any;
    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "org1" }) as any;
    ChatRepo.createMessage = async (_c, _role, content, _u, parent) => {
      created.push({ content, parent });
      return { id: "m-assistant-1", content } as any;
    };
    ChatRepo.checkpointPendingReply = async () => ({}) as any;
    ChatRepo.findAssistantReplyByParent = async () => null;
    ChatRepo.setReplyStatus = async (_id: string, status: any) => {
      statuses.push(status);
      return {} as any;
    };
    ChatRepo.findReplyState = async () =>
      ({ id: "m-user-1", consultationId: "c1", role: "user", userId: "user1", replyStatus, pendingReplyContent: "Part one." }) as any;
    ChatRepo.markReplyCancelled = async () => {
      if (replyStatus !== "PENDING") return false;
      replyStatus = "CANCELLED";
      return true;
    };
    DocumentChunkSvc.relevantChunksForConsultation = async () => ({ caseDocumentIds: [], caseDocumentChunkIds: [] });
    TranscriptionChunkSvc.relevantChunksForConsultation = async () => ({ transcriptionIds: [], transcriptionChunkIds: [] });
    redis.get = async () => null;
    redis.set = async () => {};
    (socketLib as any).emitToUser = (userId: string, event: string, payload: any) => {
      emitted.push({ userId, event, payload });
    };
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
      markReplyCancelled: originals.markReplyCancelled,
    });
    DocumentChunkSvc.relevantChunksForConsultation = originals.relevantChunksForConsultation;
    TranscriptionChunkSvc.relevantChunksForConsultation = originals.transcriptRelevantChunksForConsultation;
    redis.get = originals.redisGet;
    redis.set = originals.redisSet;
    (socketLib as any).emitToUser = originals.emitToUser;
    for (const s of sockets) s.terminate();
  });

  it("a Stop mid-stream ends the job without chat:error/chat:done, saves ONLY the partial reply, never marks the turn FAILED or DONE, and closes the Chat Wonder socket", async () => {
    const job = ChatSvc.processChatGenerationJob(baseJob);
    await flush(150); // both chunks have streamed by now; the turn is still generating

    const result = await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    await job; // resolves promptly because the abort closed the stream

    expect(result.replyStatus).to.equal("CANCELLED");
    expect(result.assistantMessageId).to.equal("m-assistant-1");
    expect(created).to.deep.equal([{ content: "Part one. Part two.", parent: baseJob.jobId }]);
    expect(statuses).to.not.include("FAILED");
    expect(statuses).to.not.include("DONE");
    const events = emitted.map((e) => e.event);
    expect(events).to.include("chat:cancelled");
    expect(events).to.not.include("chat:error");
    expect(events).to.not.include("chat:done");
    await flush(50);
    expect(sockets[0].readyState).to.not.equal(WebSocket.OPEN);
  });

  it("chunks that arrive after the Stop are not emitted", async () => {
    const job = ChatSvc.processChatGenerationJob(baseJob);
    await flush(150);
    await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    const chunksAtStop = emitted.filter((e) => e.event === "chat:chunk").length;
    try {
      sockets[0]?.send("late chunk");
    } catch {
      // already closed — which is the point
    }
    await job;
    await flush(50);
    expect(emitted.filter((e) => e.event === "chat:chunk").length).to.equal(chunksAtStop);
  });

  it("is idempotent: cancelling a turn that is no longer PENDING changes nothing and emits nothing", async () => {
    replyStatus = "DONE";
    const result = await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    expect(result).to.deep.equal({ messageId: baseJob.jobId, replyStatus: "DONE" });
    expect(created).to.deep.equal([]);
    expect(emitted).to.deep.equal([]);
  });

  it("with nothing streamed yet, saves no assistant message", async () => {
    ChatRepo.findReplyState = async () =>
      ({ id: "m-user-1", consultationId: "c1", role: "user", userId: "user1", replyStatus, pendingReplyContent: null }) as any;
    const result = await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    expect(result.replyStatus).to.equal("CANCELLED");
    expect(result.assistantMessageId).to.equal(undefined);
    expect(created).to.deep.equal([]);
  });

  it("a job that was stopped while still queued never starts generating", async () => {
    replyStatus = "CANCELLED";
    await ChatSvc.processChatGenerationJob(baseJob);
    expect(sockets.length).to.equal(0);
    expect(emitted.map((e) => e.event)).to.not.include("chat:started");
  });

  it("404s for an unknown consultation, another organization's consultation, or a message from a different consultation", async () => {
    ChatRepo.findConsultationById = async () => null;
    let err: Error | undefined;
    try {
      await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Consultation not found");

    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "other-org" }) as any;
    err = undefined;
    try {
      await ChatSvc.cancelChatGeneration("org1", "user1", "c1", baseJob.jobId);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Consultation not found");

    ChatRepo.findConsultationById = async () => ({ id: "c1", organizationId: "org1" }) as any;
    ChatRepo.findReplyState = async () =>
      ({ id: "x", consultationId: "c2", role: "user", userId: "u", replyStatus: "PENDING", pendingReplyContent: null }) as any;
    err = undefined;
    try {
      await ChatSvc.cancelChatGeneration("org1", "user1", "c1", "x");
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Message not found");
  });
});
