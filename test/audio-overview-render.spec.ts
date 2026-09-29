/**
 * turnStartTimes — the pure cumulative-offset calc behind Audio Overview's per-turn timings
 * (audio-overview-render.ts). Everything else in that file needs real ffmpeg/ffprobe binaries
 * and Polly, so this is the one piece worth testing in isolation.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import { turnStartTimes } from "../src/utils/audio-overview-render";

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
