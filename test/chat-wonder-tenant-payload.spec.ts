/** chat-wonder-v2-api#145 (CW-6): chat-wonder-v2-api clamps the reply language to each tenant's
 * allowed set, reading the tenant off `ChatRequest.jurisdiction`. `callChatWonderRest` already
 * sends `payload.jurisdiction = tenantCode`; `streamChatWonderMessageOnce` — the WebSocket path
 * `/chat-stream` turns actually take — did not, so chat-wonder's clamp had nothing to read on a
 * live streamed turn. This pins that the WS payload now carries `jurisdiction` too.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";
import * as config from "../src/config";
import { streamChatWonderMessage } from "../src/utils/chatWonder";

describe("Chat Wonder WS payload: tenant", () => {
  let server: WebSocketServer;
  let received: any[];
  let originalWsUrl: string;

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data) => {
        received.push(JSON.parse(String(data)));
        socket.send("The answer.");
        socket.send("__END__");
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
    received = [];
  });

  it("sends the tenant as `jurisdiction` on the WS payload, matching the REST path", async () => {
    await streamChatWonderMessage("sess-1", "What is the deadline?", () => {}, undefined, undefined, undefined, "UK", undefined, undefined, undefined, {
      resolveOnAnswerEnd: true,
    });

    expect(received[0].jurisdiction).to.equal("UK");
  });

  it("omits `jurisdiction` when no tenantCode is known", async () => {
    await streamChatWonderMessage("sess-1", "What is the deadline?", () => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      resolveOnAnswerEnd: true,
    });

    expect(received[0]).to.not.have.property("jurisdiction");
  });
});
