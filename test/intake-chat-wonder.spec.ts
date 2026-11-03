/**
 * streamIntakeChatWonderMessage's WS payload — no real chat-wonder, no DB: a local `ws` server
 * stands in for chat-wonder (same pattern as test/chat-generation-queue.spec.ts), and the client
 * connects to it via a swapped-out config.CHAT_WONDER_WS_URL.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";
import * as config from "../src/config";
import { streamIntakeChatWonderMessage } from "../src/utils/intakeChatWonder";

describe("streamIntakeChatWonderMessage payload", () => {
  let server: WebSocketServer;
  let originalWsUrl: string;
  let received: string[];

  before(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data) => {
        received.push(data.toString());
        socket.send("ok__END__");
        socket.send("[DONE]");
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

  beforeEach(() => {
    received = [];
  });

  it("sends case_id and user_id on the chat payload", async () => {
    await streamIntakeChatWonderMessage("sess-1", "hello", () => {}, undefined, undefined, undefined, "case-1", "user-1");

    expect(received.length).to.equal(1);
    expect(JSON.parse(received[0])).to.include({ case_id: "case-1", user_id: "user-1" });
  });

  it("omits case_id and user_id when not provided, so the fields never leak a stale value", async () => {
    await streamIntakeChatWonderMessage("sess-1", "hello", () => {});

    const payload = JSON.parse(received[0]);
    expect(payload).to.not.have.property("case_id");
    expect(payload).to.not.have.property("user_id");
  });
});
