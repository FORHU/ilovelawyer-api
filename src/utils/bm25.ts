/**
 * Okapi BM25 — term-frequency/inverse-document-frequency ranking with document-length
 * normalization (Robertson & Walker). A faithful TypeScript port of chat-wonder-v2-api's
 * `bm25.py` (that module's own docstring has the algorithm's provenance notes) — same
 * constants, same tokenization intent, same edge-case handling, so the two stay behaviorally
 * interchangeable. See `test/bm25.spec.ts`, ported from that repo's `tests/test_bm25.py`.
 *
 * Pure module: no request/session/db imports, so it can be constructed and reasoned about in
 * isolation — construct once per corpus, call `.scores()`/`.scoresNormalised()` per query.
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

// Runs of Unicode letters, or runs of digits, lower-cased first. Mirrors bm25.py's
// `[^\W\d_]+|\d+` (word chars minus digits/underscore, i.e. letters) via `\p{L}`.
const TOKEN_PATTERN = /\p{L}+|\d+/gu;

function tokenize(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().match(TOKEN_PATTERN) ?? [];
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return freq;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/** Scores a fixed corpus of texts against arbitrary queries. Construction (tokenizing every
 * document, building the IDF table) is the expensive step; scoring is cheap. */
export class BM25 {
  readonly k1: number;
  readonly b: number;
  readonly size: number;

  private readonly docTermFreq: Map<string, number>[];
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  private readonly idf: Map<string, number>;

  constructor(corpus: readonly string[], options: Bm25Options = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;

    this.docTermFreq = corpus.map((text) => termFrequencies(tokenize(text)));
    this.docLengths = this.docTermFreq.map((freq) =>
      Array.from(freq.values()).reduce((sum, n) => sum + n, 0),
    );
    this.size = corpus.length;
    this.avgDocLength = this.size ? this.docLengths.reduce((sum, n) => sum + n, 0) / this.size : 0;

    const docFreq = new Map<string, number>();
    for (const freq of this.docTermFreq) {
      for (const term of freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    // Robertson-Sparck-Jones IDF with a +1 inside the log so a term present in every document
    // floors at 0 rather than going negative (the standard BM25+ fix — matters most on a small
    // or near-duplicate-heavy corpus, e.g. a single case-document bundle).
    this.idf = new Map();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((this.size - df + 0.5) / (df + 0.5) + 1));
    }
  }

  /** Raw BM25 score for `query` against every corpus document, in corpus order. */
  scores(query: string): number[] {
    const queryTerms = tokenize(query);
    return Array.from({ length: this.size }, (_, i) => this.scoreDoc(queryTerms, i));
  }

  /** `scores()` divided by its own maximum, so the top hit is 1.0 — peak-scaled rather than
   * min-max, so one dominant hit doesn't compress every other score toward zero. */
  scoresNormalised(query: string): number[] {
    const raw = this.scores(query);
    const peak = raw.length ? Math.max(...raw) : 0;
    if (peak <= 0) return raw.map(() => 0);
    return raw.map((score) => Math.max(0, score / peak));
  }

  private scoreDoc(queryTerms: string[], docIndex: number): number {
    const docLength = this.docLengths[docIndex];
    if (docLength === 0) return 0;
    const termFreq = this.docTermFreq[docIndex];

    let score = 0;
    for (const term of queryTerms) {
      const idf = this.idf.get(term);
      const tf = idf ? termFreq.get(term) : undefined;
      if (!idf || !tf) continue; // term absent from the corpus, or from this document
      const denom = tf + this.k1 * (1 - this.b + (this.b * docLength) / (this.avgDocLength || 1));
      score += idf * ((tf * (this.k1 + 1)) / denom);
    }
    return score;
  }
}

/** Convenience one-shot: corpus indices sorted by BM25 score, highest first. Builds a fresh
 * BM25 index each call — fine for a one-off ranking, wasteful if scoring many queries against
 * the same corpus (construct `new BM25(corpus)` once and reuse it for that case instead). */
export function rank(corpus: readonly string[], query: string, topN?: number): number[] {
  const scores = new BM25(corpus).scores(query);
  const order = corpus.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  return topN !== undefined ? order.slice(0, topN) : order;
}

/** `scores` indices ranked 1..N by descending value, *excluding* any index whose score is zero,
 * negative, or non-finite entirely — such an index gets no rank at all rather than being pushed
 * to the bottom, so it contributes nothing when `rrfRankScores` looks it up. Ties break by
 * original index (lower index wins). */
function positiveRankMap(scores: readonly number[]): Map<number, number> {
  const ranked: Array<[number, number]> = [];
  scores.forEach((raw, idx) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;
    ranked.push([idx, value]);
  });
  ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  const byIndex = new Map<number, number>();
  ranked.forEach(([idx], i) => byIndex.set(idx, i + 1));
  return byIndex;
}

/**
 * Reciprocal Rank Fusion: combines two index-aligned score lists (e.g. embedding/cosine
 * similarity and `BM25.scores()`) into one fused ranking, each item scored
 * `1/(k + rankInList)` summed across whichever list(s) it has a positive rank in, then
 * peak-normalized. `k=60` is RRF's standard damping constant — large enough that rank 1 vs
 * rank 2 in one list can't swamp the other list's contribution. An item ranked well in *both*
 * lists outranks one ranked well in only one; an item absent (or non-positive) in a list simply
 * contributes 0 for that list, not a penalty.
 *
 * The two lists need not be the same length — the result is sized to the longer one.
 */
export function rrfRankScores(
  embeddingScores: readonly number[],
  bm25Scores: readonly number[],
  k = 60,
): number[] {
  const size = Math.max(embeddingScores.length, bm25Scores.length);
  if (size <= 0) return [];

  const embeddingRanks = positiveRankMap(embeddingScores);
  const bm25Ranks = positiveRankMap(bm25Scores);

  const raw: number[] = [];
  for (let idx = 0; idx < size; idx++) {
    let score = 0;
    const embeddingRank = embeddingRanks.get(idx);
    if (embeddingRank !== undefined) score += 1 / (k + embeddingRank);
    const bm25Rank = bm25Ranks.get(idx);
    if (bm25Rank !== undefined) score += 1 / (k + bm25Rank);
    raw.push(score);
  }

  const peak = raw.length ? Math.max(...raw) : 0;
  if (peak <= 0) return raw.map(() => 0);
  return raw.map((score) => Math.round((score / peak) * 1e6) / 1e6);
}
