/**
 * Confidence view: the API reading chat-wonder's `{"type":"confidence"}` envelope (sent right after
 * `__END__`), and never letting it — or any other unrecognized typed envelope — leak into the
 * answer text. Chat Wonder is a local `ws` server replaying scripted frames; no DB (same pattern as
 * test/mind-map-data-frame.spec.ts).
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach } from "mocha";
import { AddressInfo } from "net";
import WebSocket, { WebSocketServer } from "ws";

import * as config from "../src/config";
import { streamChatWonderMessage } from "../src/utils/chatWonder";
import { parseConfidencePayload } from "../src/utils/response-parser";

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "confidence",
    v: 1,
    persona: "legal_uk",
    model: "gpt-5.6-luna",
    coverage: "partial",
    legend: "provenance",
    spans: [
      { quote: "The answer.", tier: "SOURCED", source: "provenance", why: "64% of its distinctive terms appear", ref: null },
      { quote: "Employment Rights Act 1996, s 94 Law", tier: "QUOTED", source: "citation", why: "resolves", ref: "https://www.legislation.gov.uk/ukpga/1996/18/section/94" },
    ],
    tokens: null,
    ...over,
  });

describe("Confidence view envelope", () => {
  let server: WebSocketServer;
  let beforeEnd: string[];
  let afterEnd: string[];
  let originalWsUrl: string;

  before(() => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket: WebSocket) => {
      socket.on("message", () => {
        socket.send("The answer.");
        for (const frame of beforeEnd) socket.send(frame);
        socket.send("__END__");
        for (const frame of afterEnd) socket.send(frame);
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
    beforeEnd = [];
    afterEnd = [];
  });

  const stream = () =>
    streamChatWonderMessage("sess-1", "Is my dismissal unfair?", () => {}, undefined, undefined, undefined, "UK");

  it("captures the envelope and keeps it out of the answer on a turn with NO [Sources] frame", async () => {
    // The original bug: nothing set sourcesDropped, so the JSON was appended to the answer.
    afterEnd = [envelope()];
    const result = await stream();
    expect(result.content).to.equal("The answer.");
    expect(result.content).to.not.include("{");
    expect(result.confidence?.spans).to.have.length(2);
    expect(result.confidence?.persona).to.equal("legal_uk");
  });

  it("captures it on a turn WITH a [Sources] frame too", async () => {
    beforeEnd = [`[Sources] ${JSON.stringify([{ title: "ERA 1996", url: "https://x" }])}`];
    afterEnd = [envelope()];
    const result = await stream();
    expect(result.content).to.equal("The answer.");
    expect(result.confidence?.spans).to.have.length(2);
  });

  it("never appends an unrecognized typed envelope to the answer", async () => {
    afterEnd = [JSON.stringify({ type: "some_future_frame", data: { x: 1 } })];
    const result = await stream();
    expect(result.content).to.equal("The answer.");
  });

  it("ignores a malformed or unsupported envelope without failing the turn", async () => {
    afterEnd = [envelope({ v: 2 }), envelope({ persona: "intake" }), envelope({ spans: "nope" })];
    const result = await stream();
    expect(result.content).to.equal("The answer.");
    expect(result.confidence).to.equal(undefined);
  });
});

describe("parseConfidencePayload", () => {
  it("keeps valid spans and drops invalid ones", () => {
    const parsed = parseConfidencePayload({
      v: 1,
      persona: "legal",
      spans: [
        { quote: "ok", tier: "QUOTED", source: "provenance", why: "w" },
        { quote: "", tier: "QUOTED" },
        { quote: "bad tier", tier: "MAYBE" },
        null,
      ],
    });
    expect(parsed?.spans).to.have.length(1);
    expect(parsed?.spans[0].ref).to.equal(null);
    expect(parsed?.coverage).to.equal("partial");
  });

  it("returns undefined when no valid span is left", () => {
    expect(parseConfidencePayload({ v: 1, persona: "legal", spans: [{ quote: "x", tier: "NOPE" }] })).to.equal(undefined);
    expect(parseConfidencePayload(null)).to.equal(undefined);
    expect(parseConfidencePayload([])).to.equal(undefined);
  });
});
