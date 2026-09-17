/** A reply that streamed to the user must never be lost, and must be DURABLE (visible via
 * GET /messages) the instant the chat request completes — not sometime later.
 *
 * This file originally covered only queue-level durability. It now also covers the fix for a
 * race condition in how completed AI responses got persisted:
 *
 *   OLD architecture: AI streams to the client -> ChatSvc.sendMessage enqueues an SQS job ->
 *   the request ends (res.end()) -> ... sometime later ... a queue worker calls
 *   ChatSvc.persistAssistantTurn, which is what actually creates the assistant Message row.
 *   A browser refresh landing in the gap between "request ended" and "worker ran" saw no
 *   assistant message yet, even though the AI had already finished answering.
 *
 *   NEW architecture: ChatSvc.sendMessage calls ChatSvc.persistAssistantTurn synchronously,
 *   in the request path, and AWAITS it before the request is allowed to complete. Only after
 *   that succeeds does it enqueue CaseGraphPromotionQueue — background case-graph enrichment
 *   (timeline/decision-record promotion), never the message itself. The queue can no longer be
 *   the only path that creates the canonical chat message.
 *
 * Regressions covered:
 *  1. (queue) CaseGraphPromotionQueue acked (deleted) the SQS message even when the job threw,
 *     so one transient DB error discarded case-graph enrichment forever.
 *  2. (stream) streamChatWonderMessage rejected on any "[Error]" frame, even one arriving after
 *     the whole answer had been accumulated, so ChatSvc.sendMessage threw before persisting.
 *  3. (stream) streamChatWonderMessage's ws.onerror unconditionally rejected on any raw socket-
 *     level error (e.g. the connection dropping during the post-__END__ structured-data wait),
 *     even with the full answer already accumulated — same failure mode as #2, different trigger.
 *  4. (persistence ordering, this refactor) a fast browser refresh right after the AI finished
 *     answering saw no assistant message, because persistence happened later, off-request, in
 *     a queue worker.
 *
 * No AWS/DB/Redis: repository/service static methods are monkeypatched on the CommonJS module
 * objects, and the stream client talks to a local `ws` server — this codebase's established
 * pattern for testing around a live network/DB call without a real backing service.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

// --- queue -------------------------------------------------------------------------------

import * as sqs from "../src/lib/sqs";
import * as config from "../src/config";
import ChatSvc, { AssistantTurnPayload } from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import TranscriptionChunkSvc from "../src/services/transcription-chunk.service";
import DecisionRecordRepo from "../src/repositories/decision-record.repository";
import DecisionRecordSvc from "../src/services/decision-record.service";
import { redis } from "../src/lib/redis";
import CaseGraphPromotionQueue, { CaseGraphPromotionPayload } from "../src/queues/case-graph-promotion.queue";

const payload: AssistantTurnPayload = {
  consultationId: "c1",
  parentMessageId: "m1",
  effectiveCaseId: null,
  userId: "u1",
  fullResponse: "The answer.",
  relatedCases: [],
};

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("CaseGraphPromotionQueue durability", () => {
  const promotionPayload: CaseGraphPromotionPayload = {
    consultationId: "c1",
    parentMessageId: "m1",
    assistantMessageId: "a1",
    effectiveCaseId: "case1",
    userId: "u1",
    decisions: { records: [{ anchor: "x" } as any] },
  };
  const originalPromote = ChatSvc.promoteAssistantTurnToCaseGraph;
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
    // Real helper renews visibility on a timer via the AWS client; here just run the job.
    (sqs as any).withVisibilityHeartbeat = async (_u: string, _h: string | null, _t: number, job: () => Promise<unknown>) => job();
    (CaseGraphPromotionQueue as any).running = true;
    (CaseGraphPromotionQueue as any).active = 0;
    (CaseGraphPromotionQueue as any).memoryWait = [];
  });

  afterEach(() => {
    ChatSvc.promoteAssistantTurnToCaseGraph = originalPromote;
    (sqs as any).deleteMessage = originalDelete;
    (sqs as any).withVisibilityHeartbeat = originalHeartbeat;
    (CaseGraphPromotionQueue as any).running = false;
  });

  it("acks the SQS message after a successful promotion", async () => {
    ChatSvc.promoteAssistantTurnToCaseGraph = async () => {
      attempts++;
    };
    (CaseGraphPromotionQueue as any).runOne({ payload: promotionPayload, receiptHandle: "r-ok" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal(["r-ok"]);
    expect((CaseGraphPromotionQueue as any).active).to.equal(0);
  });

  it("leaves a failed SQS job un-acked so SQS redelivers it", async () => {
    ChatSvc.promoteAssistantTurnToCaseGraph = async () => {
      attempts++;
      throw new Error("Can't reach database server");
    };
    (CaseGraphPromotionQueue as any).runOne({ payload: promotionPayload, receiptHandle: "r-fail" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal([]);
    expect((CaseGraphPromotionQueue as any).active).to.equal(0);
  });

  it("retries an in-process (no receipt) job until it succeeds", async function () {
    this.timeout(10_000);
    ChatSvc.promoteAssistantTurnToCaseGraph = async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    };
    (CaseGraphPromotionQueue as any).runOne({ payload: promotionPayload, receiptHandle: null });
    await flush(2_500); // first retry lands after the 2s base backoff
    expect(attempts).to.equal(2);
    expect(deleted).to.deep.equal([]);
  });
});

describe("ChatSvc.promoteAssistantTurnToCaseGraph idempotency", () => {
  const promotionPayload: CaseGraphPromotionPayload = {
    consultationId: "c1",
    parentMessageId: "m1",
    assistantMessageId: "a1",
    effectiveCaseId: "case1",
    userId: "u1",
    decisions: { records: [{ anchor: "x" } as any] },
  };
  const originalExists = DecisionRecordRepo.existsForSourceMessage;
  const originalPromote = DecisionRecordSvc.promote;

  afterEach(() => {
    DecisionRecordRepo.existsForSourceMessage = originalExists;
    DecisionRecordSvc.promote = originalPromote;
  });

  it("promotes decisions when this turn hasn't been promoted yet", async () => {
    let promoteCalls = 0;
    DecisionRecordRepo.existsForSourceMessage = async () => false;
    DecisionRecordSvc.promote = async () => {
      promoteCalls++;
      return { count: 1 };
    };
    await ChatSvc.promoteAssistantTurnToCaseGraph(promotionPayload);
    expect(promoteCalls).to.equal(1);
  });

  it("skips promotion when this turn's decisions were already promoted — the guard against SQS redelivery double-promoting", async () => {
    let promoteCalls = 0;
    DecisionRecordRepo.existsForSourceMessage = async () => true;
    DecisionRecordSvc.promote = async () => {
      promoteCalls++;
      return { count: 1 };
    };
    await ChatSvc.promoteAssistantTurnToCaseGraph(promotionPayload);
    expect(promoteCalls).to.equal(0);
  });

  it("does nothing for a general (non-case) consultation", async () => {
    let existsCalls = 0;
    DecisionRecordRepo.existsForSourceMessage = async () => {
      existsCalls++;
      return false;
    };
    await ChatSvc.promoteAssistantTurnToCaseGraph({ ...promotionPayload, effectiveCaseId: null });
    expect(existsCalls).to.equal(0);
  });
});

describe("ChatSvc.persistAssistantTurn (canonical, synchronous persistence)", () => {
  const original = {
    findAssistantReplyByParent: ChatRepo.findAssistantReplyByParent,
    findConsultationById: ChatRepo.findConsultationById,
    createMessage: ChatRepo.createMessage,
    setReplyStatus: ChatRepo.setReplyStatus,
    saveTimeline: ChatRepo.saveTimeline,
    saveMindMap: ChatRepo.saveMindMap,
    saveRelatedCases: ChatRepo.saveRelatedCases,
  };

  afterEach(() => {
    Object.assign(ChatRepo, original);
  });

  it("creates exactly one assistant message and reports it DONE", async () => {
    let createCalls = 0;
    ChatRepo.findAssistantReplyByParent = async () => null;
    ChatRepo.findConsultationById = async () => ({ id: "c1" }) as any;
    ChatRepo.createMessage = async () => {
      createCalls++;
      return { id: "a1" } as any;
    };
    const statuses: { status: string; opts?: unknown }[] = [];
    ChatRepo.setReplyStatus = async (_id, status, opts) => {
      statuses.push({ status, opts });
      return {} as any;
    };

    const result = await ChatSvc.persistAssistantTurn(payload);

    expect(result?.id).to.equal("a1");
    expect(createCalls).to.equal(1);
    expect(statuses).to.deep.equal([{ status: "DONE", opts: { clearPendingContent: true } }]);
  });

  it("is idempotent — a duplicate completion for the same parentMessageId never creates a second assistant message (Test: duplicate completion)", async () => {
    let createCalls = 0;
    let existing: { id: string } | null = null;
    ChatRepo.findAssistantReplyByParent = async () => existing;
    ChatRepo.findConsultationById = async () => ({ id: "c1" }) as any;
    ChatRepo.createMessage = async () => {
      createCalls++;
      existing = { id: "a1" };
      return { id: "a1" } as any;
    };
    const doneCount = { n: 0 };
    ChatRepo.setReplyStatus = async (_id, status) => {
      if (status === "DONE") doneCount.n++;
      return {} as any;
    };

    const first = await ChatSvc.persistAssistantTurn(payload);
    const second = await ChatSvc.persistAssistantTurn(payload); // simulates a retry/redelivery of the same completion

    expect(createCalls).to.equal(1); // only ONE canonical assistant message ever created
    expect(first?.id).to.equal("a1");
    expect(second?.id).to.equal("a1");
    expect(doneCount.n).to.equal(2); // both calls still confirm the parent as DONE
  });

  it("returns null (not an error) without creating a message when the consultation was deleted concurrently", async () => {
    let createCalls = 0;
    ChatRepo.findAssistantReplyByParent = async () => null;
    ChatRepo.findConsultationById = async () => null; // deleted mid-generation
    ChatRepo.createMessage = async () => {
      createCalls++;
      return { id: "a1" } as any;
    };

    const result = await ChatSvc.persistAssistantTurn(payload);

    expect(result).to.equal(null);
    expect(createCalls).to.equal(0);
  });
});

// --- sendMessage: persist-before-complete ordering ----------------------------------------

describe("ChatSvc.sendMessage — canonical persistence happens before the request completes", () => {
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
    enqueue: CaseGraphPromotionQueue.enqueue,
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

  const SESSION_KEY = "chatwonder:session:c1";

  beforeEach(() => {
    script = ["The full answer.__END__", "[DONE]"];

    ChatRepo.findConsultationWithCase = async () =>
      ({ id: "c1", organizationId: "org1", caseId: null, case: null, title: "Existing title" }) as any;
    ChatRepo.createMessage = async (_consultationId, role) =>
      (role === "user" ? { id: "m-user-1" } : { id: "m-assistant-1" }) as any;
    ChatRepo.checkpointPendingReply = async () => ({}) as any;
    ChatRepo.findAssistantReplyByParent = async () => null;
    ChatRepo.findConsultationById = async () => ({ id: "c1" }) as any;
    ChatRepo.setReplyStatus = async () => ({}) as any;
    ChatRepo.saveTimeline = async () => ({}) as any;
    ChatRepo.saveMindMap = async () => ({}) as any;
    ChatRepo.saveRelatedCases = async () => ({}) as any;
    DocumentChunkSvc.relevantChunksForConsultation = async () => ({ caseDocumentIds: [], caseDocumentChunkIds: [] });
    TranscriptionChunkSvc.relevantChunksForConsultation = async () => ({ transcriptionIds: [], transcriptionChunkIds: [] });
    redis.get = (async (key: string) => (key === SESSION_KEY ? "sess-1" : null)) as any;
    redis.set = async () => {};
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
    CaseGraphPromotionQueue.enqueue = originals.enqueue;
  });

  it("Test 1/2 — persists the assistant message BEFORE enqueueing background work, and before returning to the caller", async () => {
    const events: string[] = [];
    ChatRepo.createMessage = async (_consultationId, role) => {
      if (role === "user") return { id: "m-user-1" } as any;
      events.push("assistant-message-persisted");
      return { id: "m-assistant-1" } as any;
    };
    CaseGraphPromotionQueue.enqueue = () => {
      events.push("background-work-enqueued");
    };

    await ChatSvc.sendMessage("org1", "PH", "user1", "c1", "sess-1", "Hello, I need help.", () => {});

    // The order proves the fix: canonical DB persistence happens strictly before the
    // secondary/background enqueue, and sendMessage doesn't resolve until both are done — so a
    // GET /messages issued the instant the HTTP response ends will already see the reply
    // (Test 2: refresh immediately after completion).
    expect(events).to.deep.equal(["assistant-message-persisted", "background-work-enqueued"]);
  });

  it("Test 3 — completes and persists the FULL response even when nothing is reading the stream (simulates a disconnected/refreshed browser mid-generation)", async () => {
    let persistedContent: string | undefined;
    ChatRepo.createMessage = async (_consultationId, role, content) => {
      if (role === "user") return { id: "m-user-1" } as any;
      persistedContent = content;
      return { id: "m-assistant-1" } as any;
    };
    script = ["Part one. ", "Part two. ", "Part three.__END__", "[DONE]"];

    // onChunk is a no-op — nobody is "watching" this stream, as if the browser had refreshed
    // away right after the request was issued. The backend must still finish generating and
    // persist the complete, non-truncated answer — never a partial one.
    await ChatSvc.sendMessage("org1", "PH", "user1", "c1", "sess-1", "Hello", () => {});

    expect(persistedContent).to.equal("Part one. Part two. Part three.");
  });

  it("Test 4 — DB persistence failure: no false success, replyStatus is FAILED, background work is never enqueued", async function () {
    this.timeout(20_000); // exhausts the real 2s/4s/8s backoff (~14s)
    let assistantCreateAttempts = 0;
    ChatRepo.createMessage = async (_consultationId, role) => {
      if (role === "user") return { id: "m-user-1" } as any;
      assistantCreateAttempts++;
      throw new Error("Can't reach database server");
    };
    let enqueued = false;
    CaseGraphPromotionQueue.enqueue = () => {
      enqueued = true;
    };
    const statuses: string[] = [];
    ChatRepo.setReplyStatus = async (_id, status) => {
      statuses.push(status);
      return {} as any;
    };

    let err: Error | undefined;
    try {
      await ChatSvc.sendMessage("org1", "PH", "user1", "c1", "sess-1", "Hello", () => {});
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).to.equal("Can't reach database server");
    expect(assistantCreateAttempts).to.equal(4); // 1 initial attempt + 3 retries, all failed
    expect(enqueued).to.equal(false); // background work must never be queued for a turn that was never saved
    expect(statuses).to.include("FAILED");
  });

  it("Test 5 — SQS enqueue failure: the durable message is unaffected, sendMessage still completes successfully", async () => {
    let assistantPersisted = false;
    ChatRepo.createMessage = async (_consultationId, role) => {
      if (role === "user") return { id: "m-user-1" } as any;
      assistantPersisted = true;
      return { id: "m-assistant-1" } as any;
    };
    CaseGraphPromotionQueue.enqueue = () => {
      throw new Error("SQS is down");
    };

    // Must resolve, not reject — persistence already happened; enqueue's failure is swallowed.
    await ChatSvc.sendMessage("org1", "PH", "user1", "c1", "sess-1", "Hello", () => {});

    expect(assistantPersisted).to.equal(true);
  });

  it("Test 6 — duplicate completion end to end: retrying canonical persistence after a transient failure still yields exactly one assistant message", async function () {
    this.timeout(10_000);
    let createCalls = 0;
    ChatRepo.createMessage = async (_consultationId, role) => {
      if (role === "user") return { id: "m-user-1" } as any;
      createCalls++;
      if (createCalls < 2) throw new Error("transient blip");
      return { id: "m-assistant-1" } as any;
    };

    await ChatSvc.sendMessage("org1", "PH", "user1", "c1", "sess-1", "Hello", () => {});

    expect(createCalls).to.equal(2); // one failed attempt, one that actually created the row
  });
});

// --- stream client -----------------------------------------------------------------------

describe("streamChatWonderMessage and [Error] frames", () => {
  let server: WebSocketServer;
  let script: string[] = [];
  // Set only by the ws.onerror test below, to swap in raw-socket behavior a scripted list of
  // text frames can't express (an abrupt connection failure, not a frame). Reset in that
  // test's own `finally` so every other test keeps using the plain `script` replay above.
  let onConnectionOverride: ((socket: WebSocket) => void) | null = null;
  let streamChatWonderMessage: typeof import("../src/utils/chatWonder").streamChatWonderMessage;
  let originalWsUrl: string;

  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      if (onConnectionOverride) {
        onConnectionOverride(socket);
        return;
      }
      socket.on("message", () => {
        for (const frame of script) socket.send(frame);
      });
    });
    const { port } = server.address() as AddressInfo;
    // config.ts has already captured the env by the time any spec runs (other specs import
    // app/services), and chatWonder.ts reads CHAT_WONDER_WS_URL off the config module object
    // on every call — so point the exported value at the local server instead.
    originalWsUrl = config.CHAT_WONDER_WS_URL;
    (config as any).CHAT_WONDER_WS_URL = `ws://127.0.0.1:${port}/chat-stream`;
    ({ streamChatWonderMessage } = await import("../src/utils/chatWonder"));
  });

  after(() => {
    (config as any).CHAT_WONDER_WS_URL = originalWsUrl;
    server.close();
  });

  it("rejects on [Error] when nothing has streamed (Unknown session retry path)", async () => {
    script = ["[Error] Unknown session.", "__END__"];
    let err: Error | undefined;
    try {
      await streamChatWonderMessage("s1", "hello", () => {});
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal("Unknown session.");
  });

  it("keeps the reply when [Error] arrives after content", async () => {
    script = ["First part of the answer. ", "Second part.__END__", "[Error] structured data failed", "__END__"];
    const chunks: string[] = [];
    const result = await streamChatWonderMessage("s2", "hello", (c) => chunks.push(c));
    expect(result.content).to.equal("First part of the answer. Second part.");
    expect(chunks.join("")).to.equal("First part of the answer. Second part.");
  });

  it("keeps the reply when the raw socket errors after content has arrived", async () => {
    onConnectionOverride = (socket: WebSocket) => {
      socket.on("message", () => {
        socket.send("First part of the answer. ");
        socket.send("Second part.__END__");
        // A raw TCP-level failure, not a clean close — fires the client's `ws.onerror`
        // (ECONNRESET), not `onclose`. Simulates a dropped connection during the
        // post-__END__ structured-data wait, the real-world trigger for this bug.
        (socket as unknown as { _socket: { destroy: () => void } })._socket.destroy();
      });
    };
    try {
      const chunks: string[] = [];
      const result = await streamChatWonderMessage("s3", "hello", (c) => chunks.push(c));
      expect(result.content).to.equal("First part of the answer. Second part.");
      expect(chunks.join("")).to.equal("First part of the answer. Second part.");
    } finally {
      onConnectionOverride = null;
    }
  });

  it("still rejects when the raw socket errors before any content arrives", async () => {
    onConnectionOverride = (socket: WebSocket) => {
      socket.on("message", () => {
        (socket as unknown as { _socket: { destroy: () => void } })._socket.destroy();
      });
    };
    try {
      let err: Error | undefined;
      try {
        await streamChatWonderMessage("s4", "hello", () => {});
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.equal("Chat Wonder connection error");
    } finally {
      onConnectionOverride = null;
    }
  });
});
