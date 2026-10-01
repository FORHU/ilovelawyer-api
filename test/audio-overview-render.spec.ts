/**
 * turnStartTimes — the pure cumulative-offset calc behind Audio Overview's per-turn timings
 * (audio-overview-render.ts). Everything else in that file needs real ffmpeg/ffprobe binaries
 * and Polly, so this is the one piece worth testing in isolation.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import { headerFrameSeconds, markTimingsForTurn, parseSpeechMarks, turnStartTimes } from "../src/utils/audio-overview-render";

/** An MP3 frame header followed by zeroed side info and, optionally, a tag where Xing/Info goes. */
function frame(header: number[], sideInfoBytes: number, tag?: string): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from(header).copy(bytes, 0);
  if (tag) bytes.write(tag, 4 + sideInfoBytes, "latin1");
  return bytes;
}

// MPEG-2 Layer III, 48kbps, 24kHz, mono — the shape of Polly's MP3 output.
const MPEG2_MONO_24K = [0xff, 0xf3, 0x64, 0xc0];
// MPEG-1 Layer III, 128kbps, 44.1kHz, stereo.
const MPEG1_STEREO_44K = [0xff, 0xfb, 0x90, 0x00];

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

describe("markTimingsForTurn", () => {
  it("offsets each sentence by the turn's start and converts ms to seconds", () => {
    const text = "Mary had a little lamb. It was very old.";
    const marks = [
      { time: 6, type: "sentence", start: 0, end: 23, value: "Mary had a little lamb." },
      { time: 1500, type: "sentence", start: 24, end: 40, value: "It was very old." },
    ];
    expect(markTimingsForTurn(text, marks, "sentence", 10)).to.deep.equal([
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
    const [first, second] = markTimingsForTurn(text, marks, "sentence", 0);
    expect(text.slice(first!.start, first!.end)).to.equal("It’s late — go home.");
    expect(text.slice(second!.start, second!.end)).to.equal("Fine.");
  });

  it("keeps only marks of the requested type", () => {
    const marks = [
      { time: 0, type: "sentence", start: 0, end: 9, value: "Mary had." },
      { time: 0, type: "word", start: 0, end: 4, value: "Mary" },
      { time: 380, type: "word", start: 5, end: 8, value: "had" },
    ];
    expect(markTimingsForTurn("Mary had.", marks, "word", 2)).to.deep.equal([
      { time: 2, start: 0, end: 4 },
      { time: 2.38, start: 5, end: 8 },
    ]);
    expect(markTimingsForTurn("Mary had.", marks, "sentence", 2)).to.deep.equal([{ time: 2, start: 0, end: 9 }]);
  });
});

describe("headerFrameSeconds", () => {
  it("returns one frame's length for an Info header on a 24kHz mono clip", () => {
    expect(headerFrameSeconds(frame(MPEG2_MONO_24K, 9, "Info"))).to.equal(576 / 24000);
  });

  it("detects a Xing header on an MPEG-1 stereo clip", () => {
    expect(headerFrameSeconds(frame(MPEG1_STEREO_44K, 32, "Xing"))).to.equal(1152 / 44100);
  });

  it("detects a VBRI header", () => {
    const bytes = frame(MPEG2_MONO_24K, 9);
    bytes.write("VBRI", 36, "latin1");
    expect(headerFrameSeconds(bytes)).to.equal(576 / 24000);
  });

  it("returns 0 when the first frame is plain audio", () => {
    expect(headerFrameSeconds(frame(MPEG2_MONO_24K, 9))).to.equal(0);
  });

  it("finds the first frame after an ID3v2 tag", () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0, 0, 0, 0, 0]);
    expect(headerFrameSeconds(Buffer.concat([id3, frame(MPEG2_MONO_24K, 9, "Info")]))).to.equal(576 / 24000);
  });

  it("returns 0 for a buffer with no frame", () => {
    expect(headerFrameSeconds(Buffer.alloc(32))).to.equal(0);
  });
});
