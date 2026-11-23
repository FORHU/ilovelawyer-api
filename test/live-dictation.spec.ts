/** Live voice input (LiveDictationSvc, sockets/client-dictation.socket.ts): how AWS's events are
 * read, how a stream starts, stops, is cancelled and limited, and what the socket sends back. No AWS,
 * no database: the transcriber, the access check and the socket are stand-ins. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { EventEmitter } from "events";
import type { TranscriptResultStream } from "@aws-sdk/client-transcribe-streaming";
import {
  LIVE_DICTATION_LANGUAGE,
  LiveDictationLimiter,
  LiveDictationSession,
  liveDictationFailure,
  liveSampleRate,
  piecesOf,
  type LiveDictationEvents,
  type LiveTranscriptPiece,
  type StreamTranscriber,
} from "../src/services/live-dictation.service";
import { registerDictationHandlers, type DictationSocketDeps } from "../src/sockets/client-dictation.socket";
import HttpError from "../src/utils/http-error";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Hears each chunk as a partial ("n bytes"), and once the audio ends says one final stretch. */
function echoTranscriber(seen: Uint8Array[] = [], signals: AbortSignal[] = []): StreamTranscriber {
  return async function* ({ audio, signal }) {
    signals.push(signal);
    for await (const chunk of audio) {
      seen.push(chunk);
      yield { text: `${chunk.byteLength} bytes`, partial: true } as LiveTranscriptPiece;
    }
    yield { text: "I was fired.", partial: false };
  };
}

function recorder() {
  const log: [string, ...unknown[]][] = [];
  const events: LiveDictationEvents = {
    partial: (text) => log.push(["partial", text]),
    final: (text) => log.push(["final", text]),
    end: (text) => log.push(["end", text]),
    error: (message, code) => log.push(["error", message, code]),
  };
  return { log, events };
}

describe("LiveDictationSvc", () => {
  describe("piecesOf", () => {
    it("reads partial and final results, skipping empty ones", () => {
      const event: TranscriptResultStream = {
        TranscriptEvent: {
          Transcript: {
            Results: [
              { IsPartial: true, Alternatives: [{ Transcript: " I was " }] },
              { IsPartial: false, Alternatives: [{ Transcript: "I was fired." }] },
              { IsPartial: false, Alternatives: [{ Transcript: "  " }] },
              { IsPartial: false, Alternatives: [] },
            ],
          },
        },
      };
      expect(piecesOf(event)).to.deep.equal([
        { text: "I was", partial: true },
        { text: "I was fired.", partial: false },
      ]);
    });

    it("throws an exception event with AWS's name, as the SDK would", () => {
      const event = { LimitExceededException: { Message: "Too many streams" } } as TranscriptResultStream;
      expect(() => piecesOf(event)).to.throw("Too many streams").with.property("name", "LimitExceededException");
    });
  });

  it("hears each site in its own language", () => {
    expect(LIVE_DICTATION_LANGUAGE.UK).to.equal("en-GB");
    expect(LIVE_DICTATION_LANGUAGE.KR).to.equal("ko-KR");
  });

  it("takes a whole sample rate in Transcribe's range, 16 kHz when none is asked for", () => {
    expect(liveSampleRate(undefined)).to.equal(16000);
    expect(liveSampleRate(48000)).to.equal(48000);
    for (const bad of [7999, 48001, 16000.5, "16000", NaN]) {
      expect(() => liveSampleRate(bad)).to.throw(HttpError);
    }
  });

  it("tells the person why a stream failed", () => {
    expect(liveDictationFailure(Object.assign(new Error("x"), { name: "LimitExceededException" })).code).to.equal("DICTATION_BUSY");
    const silent = Object.assign(new Error("Your request timed out because no new audio was received for 15 seconds."), { name: "BadRequestException" });
    expect(liveDictationFailure(silent).code).to.equal("DICTATION_NO_AUDIO");
    expect(liveDictationFailure(new Error("socket hang up")).code).to.equal("DICTATION_FAILED");
  });

  describe("LiveDictationSession", () => {
    it("sends partials as audio comes in, then the finals once stopped", async () => {
      const { log, events } = recorder();
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 16000, events, transcribe: echoTranscriber() });
      session.push(new Uint8Array(3200));
      await tick();
      session.push(new Uint8Array(1600));
      session.stop();
      await session.done;
      expect(log).to.deep.equal([
        ["partial", "3200 bytes"],
        ["partial", "1600 bytes"],
        ["final", "I was fired."],
        ["end", "I was fired."],
      ]);
      expect(session.open).to.equal(false);
    });

    it("still hears audio queued before the stop", async () => {
      const seen: Uint8Array[] = [];
      const { events } = recorder();
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 16000, events, transcribe: echoTranscriber(seen) });
      session.push(new Uint8Array(100));
      session.push(new Uint8Array(200));
      session.stop();
      session.push(new Uint8Array(300)); // after the stop: dropped
      await session.done;
      expect(seen.map((c) => c.byteLength)).to.deep.equal([100, 200]);
    });

    it("hands AWS at most 200 ms of audio per event", async () => {
      const seen: Uint8Array[] = [];
      const { events } = recorder();
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 16000, events, transcribe: echoTranscriber(seen) });
      session.push(new Uint8Array(16000)); // half a second
      session.stop();
      await session.done;
      expect(seen.map((c) => c.byteLength)).to.deep.equal([6400, 6400, 3200]);
    });

    it("stops by itself at the time limit, keeping only the audio inside it", async () => {
      const seen: Uint8Array[] = [];
      const { log, events } = recorder();
      // One second at 8 kHz, 16-bit: 16000 bytes.
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 8000, maxSeconds: 1, events, transcribe: echoTranscriber(seen) });
      session.push(new Uint8Array(10000));
      session.push(new Uint8Array(10000));
      session.push(new Uint8Array(10000));
      await session.done;
      expect(seen.reduce((sum, c) => sum + c.byteLength, 0)).to.equal(16000);
      expect(log.at(-1)).to.deep.equal(["end", "I was fired."]);
    });

    it("on cancel, aborts the stream and sends nothing more", async () => {
      const signals: AbortSignal[] = [];
      const { log, events } = recorder();
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 16000, events, transcribe: echoTranscriber([], signals) });
      session.push(new Uint8Array(320));
      await tick();
      session.cancel();
      await session.done;
      expect(signals[0]!.aborted).to.equal(true);
      expect(log).to.deep.equal([["partial", "320 bytes"]]);
    });

    it("reports a failed stream as an error, keeping the finals already sent", async () => {
      const { log, events } = recorder();
      const failing: StreamTranscriber = async function* () {
        yield { text: "I was fired.", partial: false };
        throw Object.assign(new Error("Too many streams"), { name: "LimitExceededException" });
      };
      const session = new LiveDictationSession({ languageCode: "en-GB", sampleRate: 16000, events, transcribe: failing });
      await session.done;
      expect(log).to.deep.equal([
        ["final", "I was fired."],
        ["error", "Voice input is busy right now. Try again in a moment, or type instead.", "DICTATION_BUSY"],
      ]);
    });
  });

  it("lets a person start only so many streams in a window", () => {
    const limiter = new LiveDictationLimiter(2, 1000);
    limiter.take("u1", 0);
    limiter.take("u1", 10);
    expect(() => limiter.take("u1", 20)).to.throw(HttpError).with.property("code", "DICTATION_RATE_LIMITED");
    limiter.take("u2", 20); // someone else isn't affected
    limiter.take("u1", 1005); // the first start has left the window
  });
});

describe("dictation socket events", () => {
  function setup(overrides: Partial<DictationSocketDeps> = {}) {
    const deps: DictationSocketDeps = {
      authorize: async () => "en-GB",
      transcribe: echoTranscriber(),
      limiter: new LiveDictationLimiter(),
      active: new Map(),
      ...overrides,
    };
    return { deps, connect: (userId = "u1") => connectSocket(userId, deps) };
  }

  function connectSocket(userId: string, deps: DictationSocketDeps) {
    const socket = new EventEmitter();
    const sent: [string, unknown][] = [];
    const client = {
      on: socket.on.bind(socket),
      emit: (event: string, payload: unknown) => {
        sent.push([event, payload]);
        return true;
      },
    };
    registerDictationHandlers(client, userId, deps);
    const start = (payload: unknown = {}) =>
      new Promise<any>((resolve) => {
        socket.emit("dictation:start", payload, resolve);
      });
    return { socket, sent, start };
  }

  it("starts in the site's language, streams the audio and sends the words back", async () => {
    const { connect } = setup({ authorize: async () => "ko-KR" });
    const { socket, sent, start } = connect();
    expect(await start({ sampleRate: 16000 })).to.deep.equal({ ok: true, languageCode: "ko-KR", sampleRate: 16000, maxSeconds: 180 });
    socket.emit("dictation:audio", Buffer.alloc(640));
    await tick();
    socket.emit("dictation:stop");
    await tick();
    await tick();
    expect(sent).to.deep.equal([
      ["dictation:partial", { text: "640 bytes" }],
      ["dictation:final", { text: "I was fired." }],
      ["dictation:end", { text: "I was fired." }],
    ]);
  });

  it("refuses a start the access check turns away, with its reason", async () => {
    const { connect } = setup({
      authorize: async () => {
        throw new HttpError("This needs your consent, which is switched off.", 403, "CONSENT_REQUIRED");
      },
    });
    const ack = await connect().start();
    expect(ack).to.deep.equal({ ok: false, message: "This needs your consent, which is switched off.", code: "CONSENT_REQUIRED" });
  });

  it("refuses a bad sample rate before checking anything else", async () => {
    let checked = false;
    const { connect } = setup({
      authorize: async () => {
        checked = true;
        return "en-GB";
      },
    });
    expect((await connect().start({ sampleRate: 1 })).code).to.equal("DICTATION_BAD_SAMPLE_RATE");
    expect(checked).to.equal(false);
  });

  it("allows one stream per person, across their sockets, until it ends", async () => {
    const { connect } = setup();
    const phone = connect();
    const laptop = connect();
    expect((await phone.start()).ok).to.equal(true);
    expect((await phone.start()).code).to.equal("DICTATION_ALREADY_ON");
    expect((await laptop.start()).code).to.equal("DICTATION_ALREADY_ON");
    expect((await connect("someone-else").start()).ok).to.equal(true);

    phone.socket.emit("dictation:stop");
    await tick();
    await tick();
    expect((await laptop.start()).ok).to.equal(true);
  });

  it("lets a new stream start right after a cancel, with nothing from the old one", async () => {
    const { connect } = setup();
    const { socket, sent, start } = connect();
    await start();
    socket.emit("dictation:cancel");
    expect((await start()).ok).to.equal(true);
    socket.emit("dictation:stop");
    await tick();
    await tick();
    expect(sent.filter(([event]) => event === "dictation:end")).to.have.length(1);
  });

  it("cancels the stream when the socket disconnects", async () => {
    const signals: AbortSignal[] = [];
    const { connect, deps } = setup({ transcribe: echoTranscriber([], signals) });
    const { socket, sent, start } = connect();
    await start();
    await tick();
    socket.emit("disconnect");
    expect(signals[0]!.aborted).to.equal(true);
    expect(deps.active.size).to.equal(0);
    await tick();
    expect(sent).to.deep.equal([]);
  });

  it("counts starts against the person's limit", async () => {
    const { connect } = setup({ limiter: new LiveDictationLimiter(1, 60_000) });
    const { socket, start } = connect();
    expect((await start()).ok).to.equal(true);
    socket.emit("dictation:cancel");
    expect((await start()).code).to.equal("DICTATION_RATE_LIMITED");
  });

  it("ignores audio that isn't binary, or sent with no stream open", async () => {
    const seen: Uint8Array[] = [];
    const { connect } = setup({ transcribe: echoTranscriber(seen) });
    const { socket, start } = connect();
    socket.emit("dictation:audio", Buffer.alloc(10)); // before start
    await start();
    socket.emit("dictation:audio", "not audio");
    socket.emit("dictation:audio", Buffer.alloc(20));
    socket.emit("dictation:stop");
    await tick();
    await tick();
    expect(seen.map((c) => c.byteLength)).to.deep.equal([20]);
  });
});
