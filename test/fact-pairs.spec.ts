import { expect } from "chai";
import { describe, it } from "mocha";
import { buildFactCandidates, chunkPairKey, contentWords, DEFAULT_CANDIDATE_OPTIONS } from "../src/utils/fact-pairs";
import type { BundleFact } from "../src/utils/bundle-facts";
import { findContradictions } from "../src/utils/fact-extract";

const fact = (chunkId: string, locator: string, kind: BundleFact["kind"], value: string, sentence: string): BundleFact => ({
  chunkId,
  documentId: "bundle",
  pageNumber: 1,
  exhibit: locator.split(" ")[0],
  locator,
  kind,
  value,
  display: value,
  sentence,
  yearInferred: false,
});

const cameras13 = fact("a", "D13 p.2", "date", "2023-11-03", "The NVR fault was closed resolved on 3 November 2023 and cameras recording.");
const cameras18 = fact("b", "D18 p.1", "date", "2023-11-14", "Meridian says the cameras were not recording on 14 November 2023 owing to the NVR fault.");
const unrelated = fact("b", "D18 p.1", "date", "2023-11-20", "Lunch was served at the canteen on 20 November 2023.");
const dob = fact("b", "D18 p.1", "date", "1977-01-11", "Date of birth of the witness recording the NVR fault cameras: 11 January 1977.");
const sims = (pairs: [string, string, number][]) => new Map(pairs.map(([a, b, s]) => [chunkPairKey(a, b), s]));

describe("contentWords", () => {
  it("drops stopwords, months, weekdays and tokens with digits", () => {
    expect([...contentWords("Sent: Mon 06 November 2023 the NVR fault")]).to.deep.equal(["nvr", "fault"]);
  });
});

describe("buildFactCandidates", () => {
  it("pairs differing values whose passages share content words, in similar chunks", () => {
    const out = buildFactCandidates([cameras13, cameras18, unrelated], sims([["a", "b", 0.8]]));
    expect(out).to.have.length(1);
    expect(out[0].left.value).to.equal("2023-11-03");
    expect(out[0].right.value).to.equal("2023-11-14");
    expect(out[0].score).to.be.closeTo(0.8 * out[0].overlap, 1e-9);
  });

  it("never pairs chunks that aren't in the similarity map", () => {
    expect(buildFactCandidates([cameras13, cameras18], sims([]))).to.deep.equal([]);
  });

  it("skips dates too far apart to be the same event, and equal values", () => {
    const same = fact("b", "D18 p.1", "date", "2023-11-03", "The NVR fault cameras were closed resolved on 3 November 2023.");
    expect(buildFactCandidates([cameras13, dob, same], sims([["a", "b", 0.9]]))).to.deep.equal([]);
  });

  it("never pairs two facts in the same chunk or on the same exhibit page", () => {
    const sameChunk = fact("a", "D13 p.2", "date", "2023-11-14", "cameras NVR fault not recording on 14 November 2023");
    const samePage = fact("c", "D13 p.2", "date", "2023-11-15", "cameras NVR fault not recording on 15 November 2023");
    expect(buildFactCandidates([cameras13, sameChunk, samePage], sims([["a", "c", 0.9]]))).to.deep.equal([]);
  });

  it("skips a pair when one sentence already states both values", () => {
    const served = fact("a", "D01 p.3", "date", "2023-11-28", "An Improvement Notice served on 28 November 2023 was withdrawn on 19 January 2024.");
    const servedWithdrawn = fact("a", "D01 p.3", "date", "2024-01-19", "An Improvement Notice served on 28 November 2023 was withdrawn on 19 January 2024.");
    const withdrawn = fact("b", "D02 p.1", "date", "2024-01-19", "The withdrawal of the Improvement Notice on 19 January 2024.");
    expect(buildFactCandidates([served, servedWithdrawn, withdrawn], sims([["a", "b", 0.9]]))).to.deep.equal([]);
  });

  it("only compares amounts in the same currency and within the ratio", () => {
    const a = fact("a", "D15 p.1", "amount", "GBP4500.00", "The invoice total for scaffold hire was paid.");
    const b = fact("b", "D16 p.1", "amount", "GBP6340.00", "The invoice total for scaffold hire was disputed.");
    const c = fact("b", "D16 p.1", "amount", "USD6340.00", "The invoice total for scaffold hire was disputed.");
    const d = fact("b", "D16 p.1", "amount", "GBP900000.00", "The invoice total for scaffold hire was disputed.");
    const out = buildFactCandidates([a, b, c, d], sims([["a", "b", 0.9]]));
    expect(out.map((x) => x.right.value)).to.deep.equal(["GBP6340.00"]);
  });

  it("keeps one candidate per pair of places and values, and respects the cap", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      fact("b", "D18 p.1", "date", `2023-11-${String(10 + i).padStart(2, "0")}`, "Meridian says the cameras were not recording owing to the NVR fault."),
    );
    const out = buildFactCandidates([cameras13, ...many], sims([["a", "b", 0.8]]), { ...DEFAULT_CANDIDATE_OPTIONS, maxCandidates: 3 });
    expect(out).to.have.length(3);
    expect(new Set(out.map((x) => x.pairKey)).size).to.equal(3);
  });
});

describe("buildFactCandidates on a large bundle", () => {
  it("keeps memory bounded without changing the top candidates", () => {
    // 100 chunks, one date each, every pair similar: 4,950 candidates — past the pruning threshold
    // (maxCandidates × 50) at the default 80, and never pruned at a huge maxCandidates.
    const extra = ["scaffold", "crane", "delivery", "inspection", "payment", "invoice", "contract"];
    const facts = Array.from({ length: 100 }, (_, i) => {
      const day = new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
      const words = `NVR fault cameras recording ${extra[i % 7]} ${extra[(i * 3) % 7]}`;
      return fact(`c${i}`, `D${i} p.1`, "date", day, `${words} noted on ${day}.`);
    });
    const pairs: [string, string, number][] = [];
    for (let i = 0; i < 100; i++) for (let j = i + 1; j < 100; j++) pairs.push([`c${i}`, `c${j}`, 0.5 + ((i * 131 + j * 17) % 997) / 2000]);

    const pruned = buildFactCandidates(facts, sims(pairs));
    const reference = buildFactCandidates(facts, sims(pairs), { ...DEFAULT_CANDIDATE_OPTIONS, maxCandidates: 1_000_000 }).slice(0, 80);

    expect(pruned).to.have.length(80);
    expect(pruned.map((c) => [c.pairKey, c.score])).to.deep.equal(reference.map((c) => [c.pairKey, c.score]));
  });
});

describe("findContradictions", () => {
  it("stops at maxHits", () => {
    const facts = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "amount" as const, key: "amount", value: String(i), excerpt: "" }));
    const left = { documentId: "a", facts: facts(1_000) };
    const right = { documentId: "b", facts: facts(1_000) };
    expect(findContradictions(left, right, 500)).to.have.length(500);
    expect(findContradictions({ documentId: "a", facts: facts(3) }, { documentId: "b", facts: facts(3) })).to.have.length(6);
  });
});
