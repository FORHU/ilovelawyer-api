/**
 * turnStartTimes — the pure cumulative-offset calc behind Audio Overview's per-turn timings
 * (audio-overview-render.ts). Everything else in that file needs real ffmpeg/ffprobe binaries
 * and Polly, so this is the one piece worth testing in isolation.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import { parseSpeechMarks, sentenceTimingsForTurn, turnStartTimes } from "../src/utils/audio-overview-render";

describe("turnStartTimes", () => {
  it("returns a cumulative offset per turn, starting at 0", () => {
    expect(turnStartTimes([4, 6.5, 3])).to.deep.equal([0, 4, 10.5]);
  });

  it("returns an empty array for no turns", () => {
    expect(turnStartTimes([])).to.deep.equal([]);
  });

  it("handles a single turn", () => {
    expect(turnStartTimes([7.2])).to.deep.equal([0]);
  });
});

describe("parseSpeechMarks", () => {
  it("parses Polly's newline-delimited JSON, skipping blank lines", () => {
    const raw =
      '{"time":6,"type":"sentence","start":0,"end":23,"value":"Mary had a little lamb."}\n' +
      '{"time":1500,"type":"sentence","start":24,"end":40,"value":"It was very old."}\n\n';
    expect(parseSpeechMarks(raw)).to.deep.equal([
      { time: 6, type: "sentence", start: 0, end: 23, value: "Mary had a little lamb." },
      { time: 1500, type: "sentence", start: 24, end: 40, value: "It was very old." },
    ]);
  });

  it("returns an empty array for empty output", () => {
    expect(parseSpeechMarks("")).to.deep.equal([]);
  });
});

describe("sentenceTimingsForTurn", () => {
  it("offsets each sentence by the turn's start and converts ms to seconds", () => {
    const text = "Mary had a little lamb. It was very old.";
    const marks = [
      { time: 6, type: "sentence", start: 0, end: 23, value: "Mary had a little lamb." },
      { time: 1500, type: "sentence", start: 24, end: 40, value: "It was very old." },
    ];
    expect(sentenceTimingsForTurn(text, marks, 10)).to.deep.equal([
      { time: 10.006, start: 0, end: 23 },
      { time: 11.5, start: 24, end: 40 },
    ]);
  });

  it("converts Polly's UTF-8 byte offsets to string indices", () => {
    // The curly apostrophe and em dash are 3 bytes each in UTF-8 but 1 string index each.
    const text = "It’s late — go home. Fine.";
    const firstEnd = Buffer.byteLength("It’s late — go home.", "utf8");
    const marks = [
      { time: 0, type: "sentence", start: 0, end: firstEnd, value: "It’s late — go home." },
      { time: 900, type: "sentence", start: firstEnd + 1, end: firstEnd + 6, value: "Fine." },
    ];
    const [first, second] = sentenceTimingsForTurn(text, marks, 0);
    expect(text.slice(first!.start, first!.end)).to.equal("It’s late — go home.");
    expect(text.slice(second!.start, second!.end)).to.equal("Fine.");
  });

  it("ignores non-sentence marks", () => {
    const marks = [{ time: 0, type: "word", start: 0, end: 4, value: "Mary" }];
    expect(sentenceTimingsForTurn("Mary", marks, 0)).to.deep.equal([]);
  });
});
