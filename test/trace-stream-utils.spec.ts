import { expect } from "chai";
import { describe, it } from "mocha";
import { MAX_TRACE_SUMMARY_CHARS, SseParser, parseStreamPayload, promptTitle } from "../src/utils/trace-stream.utils";

const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "action", summary: "Looked up a statute.", turn_id: "turn-1", ts: 1700000000, ...over });

describe("SseParser", () => {
  it("returns the data payload of each completed event", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a":1}\n\ndata: {"b":2}\n\n')).to.deep.equal(['{"a":1}', '{"b":2}']);
  });

  it("holds an event split across network chunks until it completes", () => {
    const p = new SseParser();
    expect(p.feed('data: {"summ')).to.deep.equal([]);
    expect(p.feed('ary":"x"}\n')).to.deep.equal([]);
    expect(p.feed("\n")).to.deep.equal(['{"summary":"x"}']);
  });

  it("handles CRLF line endings", () => {
    expect(new SseParser().feed("data: hello\r\n\r\n")).to.deep.equal(["hello"]);
  });

  it("joins an event's several data lines and ignores other fields and comments", () => {
    expect(new SseParser().feed(": keepalive\nevent: x\ndata: one\ndata: two\n\n")).to.deep.equal(["one\ntwo"]);
  });

  it("emits nothing for an event with no data", () => {
    expect(new SseParser().feed(": ping only\n\n")).to.deep.equal([]);
  });
});

describe("parseStreamPayload", () => {
  it("recognises the connected handshake", () => {
    expect(parseStreamPayload('{"type":"connected"}', "turn-1")).to.deep.equal({ kind: "connected" });
  });

  it("keeps an event stamped with this turn's id", () => {
    const parsed = parseStreamPayload(event(), "turn-1");
    expect(parsed).to.deep.include({ kind: "event" });
    if (parsed.kind !== "event") throw new Error("expected an event");
    expect(parsed.event.type).to.equal("action");
    expect(parsed.event.summary).to.equal("Looked up a statute.");
    expect(parsed.event.createdAt.toISOString()).to.equal(new Date(1700000000 * 1000).toISOString());
  });

  it("drops another turn's event on the same session — attribution must not be guessed", () => {
    expect(parseStreamPayload(event({ turn_id: "turn-2" }), "turn-1")).to.deep.equal({ kind: "ignore" });
  });

  it("drops an event with no turn id (a chat-wonder that does not stamp turns)", () => {
    expect(parseStreamPayload(event({ turn_id: null }), "turn-1")).to.deep.equal({ kind: "ignore" });
  });

  it("drops types a customer should never see, even if chat-wonder sent them", () => {
    expect(parseStreamPayload(event({ type: "metric" }), "turn-1")).to.deep.equal({ kind: "ignore" });
    expect(parseStreamPayload(event({ type: "raw-debug" }), "turn-1")).to.deep.equal({ kind: "ignore" });
  });

  it("drops events with no summary", () => {
    expect(parseStreamPayload(event({ summary: "   " }), "turn-1")).to.deep.equal({ kind: "ignore" });
    expect(parseStreamPayload(event({ summary: undefined }), "turn-1")).to.deep.equal({ kind: "ignore" });
  });

  it("ignores pings, non-JSON and non-objects", () => {
    expect(parseStreamPayload('{"type":"ping"}', "turn-1")).to.deep.equal({ kind: "ignore" });
    expect(parseStreamPayload("not json", "turn-1")).to.deep.equal({ kind: "ignore" });
    expect(parseStreamPayload("42", "turn-1")).to.deep.equal({ kind: "ignore" });
  });

  it("bounds a runaway summary", () => {
    const parsed = parseStreamPayload(event({ summary: "x".repeat(MAX_TRACE_SUMMARY_CHARS + 500) }), "turn-1");
    if (parsed.kind !== "event") throw new Error("expected an event");
    expect(parsed.event.summary).to.have.length(MAX_TRACE_SUMMARY_CHARS);
  });

  it("falls back to now when the timestamp is missing or invalid", () => {
    const parsed = parseStreamPayload(event({ ts: "yesterday" }), "turn-1");
    if (parsed.kind !== "event") throw new Error("expected an event");
    expect(Math.abs(parsed.event.createdAt.getTime() - Date.now())).to.be.lessThan(5000);
  });
});

describe("promptTitle", () => {
  it("uses the question, flattened to one line", () => {
    expect(promptTitle("What is the notice\n\nperiod?", 3)).to.equal("What is the notice period?");
  });

  it("strips markdown emphasis characters", () => {
    expect(promptTitle("## **Draft** a `demand` letter", 1)).to.equal("Draft a demand letter");
  });

  it("cuts a long question with an ellipsis", () => {
    const title = promptTitle("word ".repeat(40), 1);
    expect(title.length).to.be.at.most(80);
    expect(title.endsWith("…")).to.equal(true);
  });

  it("falls back to a numbered label when the message is missing or blank", () => {
    expect(promptTitle(undefined, 4)).to.equal("Turn 4");
    expect(promptTitle("  \n ", 5)).to.equal("Turn 5");
  });
});
