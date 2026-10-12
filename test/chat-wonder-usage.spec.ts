/** The ESTIMATED LlmUsage row each Chat Wonder call writes (#402, epic #399): exactly one per call,
 * whatever its outcome, and the caller's result unchanged. Chat Wonder is a local `ws` server and
 * axios is stubbed, so there is no network, Postgres or Redis; LlmUsageRepo.create is captured.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import { AddressInfo } from "net";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import * as config from "../src/config";
import LlmUsageRepo from "../src/repositories/llm-usage.repository";
import { callChatWonderRest, categorizeDocument, generateTitleViaWs, streamChatWonderMessage } from "../src/utils/chatWonder";
import { recordChatWonderUsage } from "../src/utils/chat-wonder-usage";
import { newTraceRun } from "../src/services/trace-collector.service";
import { runWithRequestContext } from "../src/lib/request-context";

const trace = (id: string, phase = "start") => `[TRACE]${JSON.stringify({ id, phase, tool: "search", label: "Searching" })}[/TRACE]`;

describe("Chat Wonder LlmUsage rows", () => {
  let server: WebSocketServer;
  let script: string[];
  let closeInstead: boolean;
  let received: any[];
  let originalWsUrl: string;
  let rows: any[];
  let restore: (() => void)[];

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data) => {
        received.push(JSON.parse(String(data)));
        if (closeInstead) return socket.close();
        for (const frame of script) socket.send(frame);
      });
    });
    originalWsUrl = config.CHAT_WONDER_WS_URL;
    (config as any).CHAT_WONDER_WS_URL = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/chat-stream`;
  });

  after(() => {
    (config as any).CHAT_WONDER_WS_URL = originalWsUrl;
    server.close();
  });

  beforeEach(() => {
    script = [];
    closeInstead = false;
    received = [];
    rows = [];
    const create = LlmUsageRepo.create;
    const post = axios.post;
    const get = axios.get;
    restore = [
      () => ((LlmUsageRepo as any).create = create),
      () => ((axios as any).post = post),
      () => ((axios as any).get = get),
    ];
    (LlmUsageRepo as any).create = async (data: object) => {
      rows.push(data);
      return data;
    };
    (axios as any).get = async () => ({ data: { session_id: "sess-1" } });
  });

  afterEach(() => restore.forEach((fn) => fn()));

  describe("streamChatWonderMessage", () => {
    const usage = { feature: "chat", userId: "user-1", organizationId: "org-1", caseId: "case-1", consultationId: "c-1" };

    it("records one ESTIMATED row: input sent once per pass, output from the reply, passCount from the trace frames", async () => {
      script = [trace("t1"), trace("t1", "result"), trace("t2"), trace("t3"), "The answer.", "__END__"];
      const chunks: string[] = [];
      const result = await streamChatWonderMessage("sess-1", "What is the deadline?", (c) => chunks.push(c), undefined, undefined, undefined, "PH", undefined, undefined, undefined, {
        resolveOnAnswerEnd: true,
        usage,
      });

      expect(result.content).to.equal("The answer.");
      expect(rows).to.have.length(1);
      const sentChars = received[0].user_input.length;
      expect(rows[0]).to.include({
        provider: "OPENAI",
        via: "chat-wonder",
        model: null,
        source: "ESTIMATED",
        feature: "chat",
        passCount: 4,
        inputTokens: Math.ceil(sentChars / 4) * 4,
        outputTokens: Math.ceil("The answer.".length / 4),
        totalTokens: Math.ceil(sentChars / 4) * 4 + Math.ceil("The answer.".length / 4),
        userId: "user-1",
        organizationId: "org-1",
        caseId: "case-1",
        consultationId: "c-1",
        success: true,
      });
      expect(rows[0].durationMs).to.be.a("number");
    });

    it("counts a plain answer with no traces as one pass", async () => {
      script = ["Short.", "__END__"];
      await streamChatWonderMessage("sess-1", "Hi", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, { resolveOnAnswerEnd: true, usage });
      expect(rows).to.have.length(1);
      expect(rows[0].passCount).to.equal(1);
    });

    it("counts what the payload carried, not only the question", async () => {
      script = ["Ok.", "__END__"];
      await streamChatWonderMessage("sess-1", "Q", () => {}, "x".repeat(4000), undefined, undefined, "PH", undefined, undefined, undefined, { resolveOnAnswerEnd: true, usage });
      expect(rows[0].inputTokens).to.be.at.least(1000);
    });

    it("records a failed call as success: false, still one row, and rethrows unchanged", async () => {
      closeInstead = true;
      let thrown: unknown;
      try {
        await streamChatWonderMessage("sess-1", "Hello", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, { resolveOnAnswerEnd: true, usage });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).to.contain("closed the stream");
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ success: false, outputTokens: 0, source: "ESTIMATED" });
      expect(rows[0].inputTokens).to.be.greaterThan(0);
    });

    it("records one row per attempt when the caller retries", async () => {
      closeInstead = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        await streamChatWonderMessage("sess-1", "Hello", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, { resolveOnAnswerEnd: true, usage }).catch(() => {});
      }
      expect(rows).to.have.length(2);
    });

    it("falls back to feature 'unknown' and the request context when the caller says nothing", async () => {
      script = ["Ok.", "__END__"];
      const context = { requestId: "r", ip: null, userAgent: null, userId: () => "ctx-user", organizationId: () => "ctx-org", tenantCode: () => null };
      await runWithRequestContext(context, () =>
        streamChatWonderMessage("sess-1", "Hello", () => {}, undefined, undefined, undefined, "PH", undefined, undefined, undefined, { resolveOnAnswerEnd: true }),
      );
      expect(rows[0]).to.include({ feature: "unknown", userId: "ctx-user", organizationId: "ctx-org" });
    });
  });

  describe("callChatWonderRest", () => {
    it("records one row with no passes, from the question and the reply", async () => {
      (axios as any).post = async () => ({ data: { response: "A reply of some length." } });
      const data = await callChatWonderRest("A question?", "sess-1", undefined, "PH", { usage: { feature: "citationProposition" } });

      expect(data.response).to.equal("A reply of some length.");
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({
        feature: "citationProposition",
        source: "ESTIMATED",
        passCount: null,
        inputTokens: Math.ceil("A question?".length / 4),
        outputTokens: Math.ceil("A reply of some length.".length / 4),
        success: true,
      });
    });

    it("records a failed call and rethrows", async () => {
      (axios as any).post = async () => {
        throw new Error("timeout");
      };
      let thrown: unknown;
      try {
        await callChatWonderRest("Q", "sess-1", undefined, "PH", { usage: { feature: "caseOutlook" } });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).to.equal("timeout");
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ feature: "caseOutlook", success: false, outputTokens: 0 });
    });
  });

  describe("categorizeDocument", () => {
    it("records one row and returns the category as before", async () => {
      (axios as any).post = async () => ({ data: { category: "Contract" } });
      const category = await categorizeDocument("some text", "a.pdf", { userId: "user-1", caseId: "case-1" });
      expect(category).to.equal("Contract");
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ feature: "documentCategorize", userId: "user-1", caseId: "case-1", success: true, passCount: null });
    });

    it("records a failure and still returns null instead of throwing", async () => {
      (axios as any).post = async () => {
        throw new Error("down");
      };
      expect(await categorizeDocument("some text", "a.pdf")).to.equal(null);
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ feature: "documentCategorize", success: false });
    });
  });

  describe("generateTitleViaWs", () => {
    it("records one row for the title call", async () => {
      script = ["Employment: Dismissal", "__END__"];
      const title = await generateTitleViaWs("Title this", { userId: "user-1", consultationId: "c-1" });
      expect(title).to.equal("Employment: Dismissal");
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({
        feature: "title",
        userId: "user-1",
        consultationId: "c-1",
        passCount: null,
        outputTokens: Math.ceil("Employment: Dismissal".length / 4),
        success: true,
      });
    });

    it("records a socket close with no reply as a title call that produced nothing, once", async () => {
      closeInstead = true;
      await generateTitleViaWs("Title this").catch(() => {});
      expect(rows).to.have.length(1);
      expect(rows[0]).to.include({ feature: "title", outputTokens: 0 });
    });
  });

  describe("recordChatWonderUsage", () => {
    it("takes feature, case and user from the trace run when the caller names none", () => {
      const run = newTraceRun("witnessScoring", "case-9", "user-9");
      recordChatWonderUsage({ trace: run, startedAt: Date.now(), inputChars: 400, outputChars: 40, traceStarts: 2, success: true });
      expect(rows[0]).to.include({ feature: "witnessScoring", caseId: "case-9", userId: "user-9", passCount: 3, inputTokens: 300, outputTokens: 10 });
    });

    it("lets an explicit usage feature win over the trace source", () => {
      const run = newTraceRun("witnessScoring", "case-9", "user-9");
      recordChatWonderUsage({ usage: { feature: "witnessRefresh" }, trace: run, startedAt: Date.now(), inputChars: 4, outputChars: 4, traceStarts: null, success: true });
      expect(rows[0]).to.include({ feature: "witnessRefresh", passCount: null, inputTokens: 1 });
    });
  });
});
