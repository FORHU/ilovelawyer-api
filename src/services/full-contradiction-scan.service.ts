import DocumentChunkRepo from "../repositories/document-chunk.repository";
import FactPairCheckRepo from "../repositories/fact-pair-check.repository";
import { extractBundleFacts, BundleFact } from "../utils/bundle-facts";
import { buildFactCandidates, chunkPairKey, DEFAULT_CANDIDATE_OPTIONS, FactCandidate } from "../utils/fact-pairs";
import { classifyContradictionWithJev, ContradictionNatureValue } from "../utils/contradiction-nature-jev";
import type { ContradictionHit } from "../utils/fact-extract";
import { TenantCode } from "../types/tenant-code";
import logger from "../utils/logger";

/**
 * Full-bundle contradiction scan. The older scan hands Chat Wonder a ~32-chunk sample, which for
 * a single merged bundle is a few percent of it; this one reads every chunk:
 *
 *   1. extractBundleFacts — every date, amount and duration, with exhibit/page (no AI)
 *   2. findSimilarChunkPairs + buildFactCandidates — pairs of differing values whose passages are
 *      about the same thing (existing embeddings + shared words; no AI)
 *   3. Jev — DIRECT / INFERENTIAL / NOT_A_CONFLICT on each candidate; only DIRECT and INFERENTIAL
 *      at or above MIN_ACCEPT_CONFIDENCE become contradictions. Verdicts are cached per pair
 *      (FactPairCheck), so a rescan only pays for pairs it hasn't seen.
 *
 * Off unless USE_FULL_CONTRADICTION_SCAN=true. Needs TYPESAFE_API_KEY. Gate with
 * scripts/full-contradiction-scan-benchmark.ts against the Brackenmoor bundle's planted conflicts.
 */

export function isFullContradictionScanEnabled(): boolean {
  return process.env.USE_FULL_CONTRADICTION_SCAN === "true";
}

// Tuned on the Brackenmoor bundle (745 chunks, 365 facts → 37 candidates). Provisional: re-set
// from the benchmark.
const MIN_CHUNK_SIMILARITY = 0.45;
const SIMILAR_CHUNKS_PER_CHUNK = 8;
/** A candidate is shown only if Jev calls it DIRECT or INFERENTIAL with at least this confidence.
 * From the first Brackenmoor run (benchmarks/full-contradiction-scan/): 35 of 37 candidates came
 * back NOT_A_CONFLICT, mostly at 88-100%; the one real conflict (INS/4 dated 2.02.2024 on D17 p.1
 * but 2 February 2025 on D17 p.3) was DIRECT at 54%, the other DIRECT (a Pay Less Notice date vs
 * a sum's due date — different events) at 26%. One positive is thin; re-set as labels accumulate. */
export const MIN_ACCEPT_CONFIDENCE = 0.5;
const JEV_CONCURRENCY = 5;

export type FullScanHit = ContradictionHit & {
  nature: "DIRECT" | "INFERENTIAL";
  natureConfidence: number;
  leftLocator: string | null;
  rightLocator: string | null;
};

export interface FullScanVerdict {
  candidate: FactCandidate;
  nature: ContradictionNatureValue | null;
  confidence: number | null;
  cached: boolean;
  accepted: boolean;
}

export interface FullScanResult {
  hits: FullScanHit[];
  verdicts: FullScanVerdict[];
  stats: { documents: number; chunks: number; facts: number; candidates: number; jevChecked: number; cached: number; accepted: number };
}

export interface FullScanOptions {
  /** false = candidates only, no Jev calls (the benchmark's dry run). */
  jev?: boolean;
  /** false = don't read or write FactPairCheck (the benchmark scores fresh verdicts). */
  cache?: boolean;
}

const HIT_KIND: Record<BundleFact["kind"], string> = { date: "date_mismatch", amount: "amount_mismatch", duration: "other_mismatch" };

function where(f: BundleFact, docName: Map<string, string>): string {
  const name = docName.get(f.documentId) ?? "Document";
  return f.locator ? `${f.locator} (${name})` : name;
}

export default class FullContradictionScanSvc {
  static async scan(
    caseId: string,
    docs: { id: string; name: string }[],
    tenantCode: TenantCode,
    opts: FullScanOptions = {},
  ): Promise<FullScanResult> {
    const useJev = opts.jev ?? true;
    const useCache = opts.cache ?? true;
    const docName = new Map(docs.map((d) => [d.id, d.name]));

    const facts: BundleFact[] = [];
    let chunkCount = 0;
    for (const doc of docs) {
      const chunks = await DocumentChunkRepo.findTextsByIds(await DocumentChunkRepo.findIdsByDocument(doc.id));
      chunkCount += chunks.length;
      // UK bundles write 03/04/2024 as 3 April; PH (and US-style) documents as March 4.
      facts.push(...extractBundleFacts(chunks, { numericDayFirst: tenantCode === "UK" }));
    }

    const factChunkIds = [...new Set(facts.map((f) => f.chunkId))];
    const similar = await DocumentChunkRepo.findSimilarChunkPairs(factChunkIds, MIN_CHUNK_SIMILARITY, SIMILAR_CHUNKS_PER_CHUNK);
    const similarities = new Map<string, number>();
    for (const row of similar) {
      const key = chunkPairKey(row.a, row.b);
      similarities.set(key, Math.max(similarities.get(key) ?? 0, row.similarity));
    }
    const candidates = buildFactCandidates(facts, similarities, DEFAULT_CANDIDATE_OPTIONS);

    const cached = useCache
      ? new Map((await FactPairCheckRepo.findByKeys(caseId, candidates.map((c) => c.pairKey))).map((r) => [r.pairKey, r]))
      : new Map();
    const verdicts: FullScanVerdict[] = candidates.map((candidate) => {
      const hit = cached.get(candidate.pairKey);
      return { candidate, nature: hit?.nature ?? null, confidence: hit?.confidence ?? null, cached: !!hit, accepted: false };
    });

    let jevChecked = 0;
    if (useJev) {
      const pending = verdicts.filter((v) => !v.cached);
      for (let i = 0; i < pending.length; i += JEV_CONCURRENCY) {
        await Promise.all(
          pending.slice(i, i + JEV_CONCURRENCY).map(async (v) => {
            const { left, right } = v.candidate;
            try {
              const r = await classifyContradictionWithJev({
                factKey: left.kind,
                left: { document: where(left, docName), excerpt: left.sentence, value: left.display },
                right: { document: where(right, docName), excerpt: right.sentence, value: right.display },
              });
              v.nature = r.rawNature;
              v.confidence = r.confidence;
              jevChecked += 1;
            } catch (err) {
              // Left unchecked (nature null) — not cached, so the next scan tries it again.
              logger.warn("Full contradiction scan: Jev check failed for one pair", { err, caseId, pairKey: v.candidate.pairKey });
            }
          }),
        );
      }
      if (useCache) {
        await FactPairCheckRepo.saveMany(
          caseId,
          pending
            .filter((v) => v.nature && v.confidence !== null)
            .map((v) => ({ pairKey: v.candidate.pairKey, nature: v.nature!, confidence: v.confidence! })),
        );
      }
    }

    const hits: FullScanHit[] = [];
    for (const v of verdicts) {
      v.accepted = (v.nature === "DIRECT" || v.nature === "INFERENTIAL") && (v.confidence ?? 0) >= MIN_ACCEPT_CONFIDENCE;
      if (!v.accepted) continue;
      const { left, right } = v.candidate;
      hits.push({
        kind: HIT_KIND[left.kind],
        factKey: left.kind,
        leftValue: left.value,
        rightValue: right.value,
        leftExcerpt: left.sentence,
        rightExcerpt: right.sentence,
        leftDocumentId: left.documentId,
        rightDocumentId: right.documentId,
        confidence: v.confidence!,
        nature: v.nature as "DIRECT" | "INFERENTIAL",
        natureConfidence: v.confidence!,
        leftLocator: left.locator,
        rightLocator: right.locator,
      });
    }

    const stats = {
      documents: docs.length,
      chunks: chunkCount,
      facts: facts.length,
      candidates: candidates.length,
      jevChecked,
      cached: verdicts.filter((v) => v.cached).length,
      accepted: hits.length,
    };
    logger.info("Full contradiction scan", { caseId, ...stats });
    return { hits, verdicts, stats };
  }
}
