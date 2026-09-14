/** A reply that streamed to the user must never be lost at persistence time.
 *
 * Two regressions, both observed on staging as "the AI answered, but the message is gone
 * after a page reload":
 *  1. MessagePersistenceQueue acked (deleted) the SQS message even when
 *     persistAssistantTurn threw, so one transient DB error discarded the turn forever.
 *  2. streamChatWonderMessage rejected on any "[Error]" frame, even one arriving after the
 *     whole answer had been accumulated, so ChatSvc.sendMessage threw before enqueueing.
 *
 * No AWS/DB/Redis: sqs helpers and ChatSvc.persistAssistantTurn are monkeypatched on the
 * CommonJS module objects, and the stream client talks to a local `ws` server.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

// --- queue -------------------------------------------------------------------------------

import * as sqs from "../src/lib/sqs";
import * as config from "../src/config";
import ChatSvc from "../src/services/chat.service";
import MessagePersistenceQueue, { AssistantTurnPayload } from "../src/queues/message-persistence.queue";

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

describe("MessagePersistenceQueue durability", () => {
  const originalPersist = ChatSvc.persistAssistantTurn;
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
    (MessagePersistenceQueue as any).running = true;
    (MessagePersistenceQueue as any).active = 0;
    (MessagePersistenceQueue as any).memoryWait = [];
  });

  afterEach(() => {
    ChatSvc.persistAssistantTurn = originalPersist;
    (sqs as any).deleteMessage = originalDelete;
    (sqs as any).withVisibilityHeartbeat = originalHeartbeat;
    (MessagePersistenceQueue as any).running = false;
  });

  it("acks the SQS message after a successful persist", async () => {
    ChatSvc.persistAssistantTurn = async () => {
      attempts++;
    };
    (MessagePersistenceQueue as any).runOne({ payload, receiptHandle: "r-ok" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal(["r-ok"]);
    expect((MessagePersistenceQueue as any).active).to.equal(0);
  });

  it("leaves a failed SQS job un-acked so SQS redelivers it", async () => {
    ChatSvc.persistAssistantTurn = async () => {
      attempts++;
      throw new Error("Can't reach database server");
    };
    (MessagePersistenceQueue as any).runOne({ payload, receiptHandle: "r-fail" });
    await flush();
    expect(attempts).to.equal(1);
    expect(deleted).to.deep.equal([]);
    expect((MessagePersistenceQueue as any).active).to.equal(0);
  });

  it("retries an in-process (no receipt) job until it succeeds", async function () {
    this.timeout(10_000);
    ChatSvc.persistAssistantTurn = async () => {
      attempts++;
      if (attempts < 2) throw new Error("transient");
    };
    (MessagePersistenceQueue as any).runOne({ payload, receiptHandle: null });
    await flush(2_500); // first retry lands after the 2s base backoff
    expect(attempts).to.equal(2);
    expect(deleted).to.deep.equal([]);
  });
});

// --- stream client -----------------------------------------------------------------------

describe("streamChatWonderMessage and [Error] frames", () => {
  let server: WebSocketServer;
  let script: string[] = [];
  let streamChatWonderMessage: typeof import("../src/utils/chatWonder").streamChatWonderMessage;
  let originalWsUrl: string;

  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
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
});
