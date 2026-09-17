import { expect } from "chai";
import { describe, it } from "mocha";
import { BM25, rank, rrfRankScores } from "../src/utils/bm25";

// Ported from chat-wonder-v2-api's tests/test_bm25.py — same corpus, same assertions, so this
// file's pass/fail is a direct parity check against that implementation.

describe("BM25", () => {
  const corpus = [
    "the claimant slipped on the wet floor near the loading bay",
    "the loading bay floor was wet because the drain had blocked",
    "judgment in 2019 UKSC 41 on the scope of the duty of care",
    "annual report prepared after the judgment was handed down",
  ];

  it("exact term match outranks an unrelated document", () => {
    const bm25 = new BM25(corpus);
    const scores = bm25.scores("wet floor");
    expect(scores[0]).to.be.greaterThan(scores[2]);
    expect(scores[1]).to.be.greaterThan(scores[2]);
  });

  it("rare term outweighs a common term", () => {
    // "the" appears in every document (near-zero IDF); "judgment" appears in two.
    const bm25 = new BM25(corpus);
    const scores = bm25.scores("judgment");
    expect(scores[2]).to.be.greaterThan(scores[0]);
    expect(scores[3]).to.be.greaterThan(scores[0]);
  });

  it("scores everything zero for an empty query", () => {
    const bm25 = new BM25(corpus);
    expect(bm25.scores("")).to.deep.equal(corpus.map(() => 0));
  });

  it("scores zero when the query term is absent from the corpus", () => {
    const bm25 = new BM25(corpus);
    expect(bm25.scores("nonexistent gibberish zzqx")).to.deep.equal(corpus.map(() => 0));
  });

  it("returns empty scores for an empty corpus", () => {
    const bm25 = new BM25([]);
    expect(bm25.scores("anything")).to.deep.equal([]);
  });

  it("scoresNormalised peaks at one", () => {
    const bm25 = new BM25(corpus);
    const normalised = bm25.scoresNormalised("wet floor");
    expect(Math.max(...normalised)).to.be.closeTo(1.0, 1e-9);
    for (const score of normalised) {
      expect(score).to.be.at.least(0);
      expect(score).to.be.at.most(1);
    }
  });

  it("scoresNormalised is all zero when nothing matches", () => {
    const bm25 = new BM25(corpus);
    expect(bm25.scoresNormalised("zzqx nonexistent")).to.deep.equal(corpus.map(() => 0));
  });

  it("does not automatically favour a longer document (length normalization)", () => {
    // b=0.75: a short doc mentioning the term once should not lose to a much longer doc that
    // only mentions it once amid unrelated padding.
    const short = "duty of care applies here";
    const longPadded = "duty of care applies here " + "filler text ".repeat(40);
    const bm25 = new BM25([short, longPadded]);
    const scores = bm25.scores("duty of care");
    expect(scores[0]).to.be.at.least(scores[1]);
  });
});

describe("rank", () => {
  it("orders corpus indices by descending BM25 score", () => {
    const corpus = ["cats and cats and birds", "dogs", "nothing relevant here at all"];
    const order = rank(corpus, "dogs");
    expect(order[0]).to.equal(1); // only doc containing "dogs" at all
    expect(order.slice(1)).to.not.include(1); // sanity: not just input order
  });

  it("respects topN", () => {
    const corpus = ["a b c", "a b", "a"];
    expect(rank(corpus, "a b c", 2)).to.have.length(2);
  });
});

describe("rrfRankScores", () => {
  it("ranks an item well-placed in both lists above one well-placed in only one", () => {
    // idx0: rank 1 in both lists. idx1: rank 1 embedding, absent from bm25. idx2: opposite.
    const embeddingScores = [0.9, 0.8, 0.1];
    const bm25Scores = [5.0, 0.0, 4.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    expect(fused[0]).to.be.greaterThan(fused[1]);
    expect(fused[0]).to.be.greaterThan(fused[2]);
  });

  it("excludes a zero/negative score from that list's ranking entirely", () => {
    // idx1 has a 0.0 bm25 score — must be excluded from the bm25 rank map, not merely ranked
    // last (which would still contribute 1/(k+worstRank)).
    const embeddingScores = [0.5, 0.5];
    const bm25Scores = [0.0, 0.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    // Both tie on embedding rank (idx0 wins the tie-break) and both are excluded from bm25
    // entirely, so idx0 > idx1, and neither is zero (both ranked on the embedding list).
    expect(fused[0]).to.be.greaterThan(fused[1]);
    expect(fused[1]).to.be.greaterThan(0);
  });

  it("scores zero for an item absent from both lists", () => {
    const embeddingScores = [0.9, 0.0, 0.0];
    const bm25Scores = [3.0, 0.0, 0.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    expect(fused[1]).to.equal(0);
    expect(fused[2]).to.equal(0);
  });

  it("sizes the result to the longer list on a length mismatch", () => {
    const embeddingScores = [0.9, 0.8, 0.7, 0.6];
    const bm25Scores = [5.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    expect(fused).to.have.length(4);
  });

  it("peak-normalises so the top score is one", () => {
    const embeddingScores = [0.9, 0.5, 0.1];
    const bm25Scores = [5.0, 2.0, 1.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    expect(Math.max(...fused)).to.equal(1);
  });

  it("returns empty when both lists are empty", () => {
    expect(rrfRankScores([], [])).to.deep.equal([]);
  });

  it("breaks ties by lower index", () => {
    const embeddingScores = [0.5, 0.5, 0.5];
    const bm25Scores = [0.0, 0.0, 0.0];
    const fused = rrfRankScores(embeddingScores, bm25Scores);
    expect(fused[0]).to.be.greaterThan(fused[1]);
    expect(fused[1]).to.be.greaterThan(fused[2]);
  });

  it("dampens rank-one dominance as k grows", () => {
    // A larger k pulls every fused score closer together (before peak-normalization the gap
    // between rank 1 and rank 2 shrinks as k grows) — confirms k is actually wired through
    // rather than hardcoded.
    const embeddingScores = [0.9, 0.8, 0.7];
    const bm25Scores = [5.0, 4.0, 3.0];
    const tightK = rrfRankScores(embeddingScores, bm25Scores, 1);
    const looseK = rrfRankScores(embeddingScores, bm25Scores, 1000);
    expect(tightK[0] - tightK[2]).to.be.greaterThan(looseK[0] - looseK[2]);
  });
});
