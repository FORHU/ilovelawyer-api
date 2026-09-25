import type { BundleFact } from "./bundle-facts";

/**
 * Pass 2 of the full-bundle contradiction scan: which pairs of facts are worth asking Jev about?
 * Comparing every date with every other date is ~45,000 pairs for a 300-date bundle, almost all
 * about unrelated events. Instead a pair is only a candidate when the two passages it sits in are
 * about the same thing — measured by the cosine similarity of their chunks' existing embeddings —
 * and the two values are the same kind but differ. Pure: the similarities come in from the caller.
 */

export interface FactCandidate {
  left: BundleFact;
  right: BundleFact;
  /** Cosine similarity of the two chunks the facts sit in. */
  similarity: number;
  /** Share of content words the two facts' sentences have in common (overlap coefficient). */
  overlap: number;
  /** Ranking score: similarity × overlap. */
  score: number;
  /** Stable across rescans: which two places, which two values. Keys the FactPairCheck cache. */
  pairKey: string;
}

export interface CandidateOptions {
  /** Most candidates to return — the Jev budget for one scan. */
  maxCandidates: number;
  /** Two dates further apart than this are about different events (a date of birth vs the
   * incident), not one event dated two ways. */
  maxDateGapDays: number;
  /** Two amounts more than this many times apart are not the same sum misstated. */
  maxAmountRatio: number;
  /** Chunk similarity alone is coarse — a long interview page shares a chunk with a dozen unrelated
   * dates. The two sentences must also share at least this share of their content words... */
  minOverlap: number;
  /** ...and at least this many of them. */
  minSharedWords: number;
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateOptions = {
  maxCandidates: 80,
  maxDateGapDays: 730,
  maxAmountRatio: 10,
  minOverlap: 0.25,
  minSharedWords: 2,
};

const STOPWORDS = new Set(
  (
    "the and for that this with was were are been from have has had not but you your our their his her its they them she " +
    "him who which what when where there here into onto upon about after before over under than then also only said says " +
    "would could should will shall may might must can did does done any all each some such other more most very just per " +
    "dated date day days week weeks month months year years time page para item part section " +
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec " +
    // Weekdays and email-header words: two "Sent: Mon 6 November" headers share these and
    // nothing else, so they must not count as the passages being about the same thing.
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun " +
    "sent received subject attachment attachments"
  ).split(" "),
);

/** Lowercase content words of a sentence, minus stopwords, month names and anything with a digit. */
export function contentWords(sentence: string): Set<string> {
  const out = new Set<string>();
  for (const w of sentence.toLowerCase().split(/[^a-z0-9'-]+/)) {
    const word = w.replace(/^'+|'+$/g, "");
    if (word.length < 3 || /\d/.test(word) || STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

function overlapOf(a: Set<string>, b: Set<string>): { shared: number; overlap: number } {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const denom = Math.min(a.size, b.size);
  return { shared, overlap: denom ? shared / denom : 0 };
}

/** "chunkA|chunkB" with the ids in sorted order. */
export function chunkPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function factPairKey(a: BundleFact, b: BundleFact): string {
  const side = (f: BundleFact) => `${f.documentId}@${f.locator ?? f.chunkId}=${f.kind}:${f.value}`;
  return [side(a), side(b)].sort().join("|");
}

function comparable(a: BundleFact, b: BundleFact, opts: CandidateOptions): boolean {
  if (a.kind !== b.kind || a.value === b.value) return false;
  if (a.kind === "date") {
    const gap = Math.abs(Date.parse(a.value) - Date.parse(b.value)) / 86_400_000;
    return Number.isFinite(gap) && gap <= opts.maxDateGapDays;
  }
  if (a.kind === "amount") {
    const cur = (v: string) => v.replace(/[\d.]+$/, "");
    const num = (v: string) => Number(v.replace(/^[A-Z]+/, ""));
    if (cur(a.value) !== cur(b.value)) return false;
    const [x, y] = [num(a.value), num(b.value)];
    return x > 0 && y > 0 && Math.max(x, y) / Math.min(x, y) <= opts.maxAmountRatio;
  }
  return true;
}

/**
 * `similarities` maps chunkPairKey → cosine similarity, already filtered to the pairs worth
 * considering. Facts in the same chunk are never paired (a range like "13 to 14 November" is not
 * a contradiction), nor two facts from the same exhibit page, nor two whose sentences share too
 * few content words. The same two values seen again in the same two places keep only the
 * best-scoring occurrence. Highest score first.
 */
export function buildFactCandidates(
  facts: BundleFact[],
  similarities: Map<string, number>,
  opts: CandidateOptions = DEFAULT_CANDIDATE_OPTIONS,
): FactCandidate[] {
  const byChunk = new Map<string, BundleFact[]>();
  for (const f of facts) {
    const list = byChunk.get(f.chunkId) ?? [];
    list.push(f);
    byChunk.set(f.chunkId, list);
  }

  // Every value each sentence states. If one side's sentence also states the other side's value
  // ("served 28 November, withdrawn 19 January" vs "withdrawn 19 January"), the two passages
  // agree on both events — two different facts, not one fact given two values.
  const valuesIn = new Map<string, Set<string>>();
  for (const f of facts) {
    const key = `${f.chunkId}#${f.sentence}`;
    const set = valuesIn.get(key) ?? new Set<string>();
    set.add(`${f.kind}:${f.value}`);
    valuesIn.set(key, set);
  }
  const states = (f: BundleFact, other: BundleFact) =>
    valuesIn.get(`${f.chunkId}#${f.sentence}`)?.has(`${other.kind}:${other.value}`) ?? false;

  const words = new Map<BundleFact, Set<string>>();
  const wordsOf = (f: BundleFact) => {
    let w = words.get(f);
    if (!w) words.set(f, (w = contentWords(f.sentence)));
    return w;
  };

  const best = new Map<string, FactCandidate>();
  for (const [key, similarity] of similarities) {
    const [a, b] = key.split("|");
    for (const fa of byChunk.get(a) ?? []) {
      for (const fb of byChunk.get(b) ?? []) {
        if (!comparable(fa, fb, opts)) continue;
        if (fa.documentId === fb.documentId && fa.locator && fa.locator === fb.locator) continue;
        if (states(fa, fb) || states(fb, fa)) continue;
        const { shared, overlap } = overlapOf(wordsOf(fa), wordsOf(fb));
        if (shared < opts.minSharedWords || overlap < opts.minOverlap) continue;
        const score = similarity * overlap;
        const pairKey = factPairKey(fa, fb);
        const prev = best.get(pairKey);
        if (!prev || prev.score < score) {
          const [left, right] = fa.documentId + fa.chunkId < fb.documentId + fb.chunkId ? [fa, fb] : [fb, fa];
          best.set(pairKey, { left, right, similarity, overlap, score, pairKey });
        }
      }
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, opts.maxCandidates);
}
