import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { extractFacts } from "./fact-extract";

export type ReadyDoc = { id: string; name: string };

type ChunkRow = { id: string; caseDocumentId: string; chunkText: string; chunkIndex: number; pageNumber: number | null };

// Total chunks sampled across every ready document for one generation call (Case Strategy,
// Case Finding, Case Reconstruction, Evidence Intelligence). Budgeted per-document below, not
// as a flat case-wide top-K — see allocatePerDocumentBudget's docstring.
const TOTAL_CHUNK_BUDGET = 32;
const TEXT_CAP_CHARS = 16000;

/** Every ready document gets an even floor share of the chunk budget before any leftover budget
 * is handed out — a case with many documents no longer lets a few large/fact-dense exhibits
 * crowd out every sample slot from smaller or numerically-sparse ones (e.g. an admission letter
 * with no dollar figures or dates in it, sitting next to a financial ledger with hundreds of
 * chunks). Within each document, chunks that contain an extractable fact (see fact-extract.ts —
 * currency amounts and dates only) are preferred over the rest of that SAME document's chunks;
 * unlike the previous version, a document with zero fact chunks of its own still gets sampled
 * from its own full chunk set, rather than being folded into a case-wide fact/no-fact pool. */
export async function buildFactExcerptPack(ready: ReadyDoc[]): Promise<{ chunkIds: string[]; text: string; factCount: number }> {
  if (ready.length === 0) return { chunkIds: [], text: "", factCount: 0 };

  let factCount = 0;
  const pools: ChunkRow[][] = [];
  for (const doc of ready) {
    const ids = await DocumentChunkRepo.findIdsByDocument(doc.id);
    const rows = await DocumentChunkRepo.findTextsByIds(ids);
    const factChunks = rows.filter((chunk) => extractFacts(chunk.chunkText).length > 0);
    factCount += factChunks.length;
    pools.push(factChunks.length > 0 ? factChunks : rows);
  }

  const chosen = allocatePerDocumentBudget(pools, TOTAL_CHUNK_BUDGET).flat();

  const text = chosen
    .map((chunk) => {
      const page = chunk.pageNumber != null ? ` p.${chunk.pageNumber}` : "";
      return `[${chunk.caseDocumentId}${page}]\n${chunk.chunkText.slice(0, 700)}`;
    })
    .join("\n\n")
    .slice(0, TEXT_CAP_CHARS);

  return { chunkIds: chosen.map((chunk) => chunk.id), text, factCount };
}

/** Splits `totalBudget` items across `pools` (one pool per document, in input order) so every
 * non-empty pool gets an even floor share — `Math.floor(totalBudget / pools.length)`, at least
 * 1 — before any leftover budget (floor division rounding down, or a pool with fewer items than
 * its floor) is handed out round-robin, one item per pool per pass, to pools that still have
 * unselected items. A pool's floor share is spread evenly across its own items by index
 * position, not just its first N. Never lets one pool's size crowd out another pool's floor —
 * the failure this replaces was a single case-wide top-K cut that let a few large/textually-
 * dominant documents consume the whole budget, leaving smaller documents with zero. Exported
 * (rather than kept private to buildFactExcerptPack) so this allocation behavior is unit-testable
 * without a database. */
export function allocatePerDocumentBudget<T extends { id: string }>(pools: T[][], totalBudget: number): T[][] {
  const nonEmpty = pools.filter((p) => p.length > 0);
  if (nonEmpty.length === 0 || totalBudget <= 0) return pools.map(() => []);

  const baseQuota = Math.max(1, Math.floor(totalBudget / nonEmpty.length));
  const chosen = new Map<T[], T[]>();
  const leftover = new Map<T[], T[]>();

  for (const pool of pools) {
    const picked = takeEvenlySpaced(pool, baseQuota);
    const pickedIds = new Set(picked.map((item) => item.id));
    chosen.set(pool, picked);
    leftover.set(pool, pool.filter((item) => !pickedIds.has(item.id)));
  }

  let remaining = totalBudget - pools.reduce((sum, pool) => sum + (chosen.get(pool)?.length ?? 0), 0);
  let madeProgress = remaining > 0;
  while (remaining > 0 && madeProgress) {
    madeProgress = false;
    for (const pool of pools) {
      if (remaining <= 0) break;
      const next = leftover.get(pool)?.shift();
      if (next) {
        chosen.get(pool)!.push(next);
        remaining -= 1;
        madeProgress = true;
      }
    }
  }

  return pools.map((pool) => chosen.get(pool) ?? []);
}

function takeEvenlySpaced<T extends { id: string }>(items: T[], max: number): T[] {
  if (max <= 0 || items.length === 0) return [];
  if (items.length <= max) return items;
  const picked: T[] = [];
  const seen = new Set<string>();
  const step = items.length / max;
  for (let i = 0; i < max; i++) {
    const item = items[Math.min(items.length - 1, Math.floor(i * step))];
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      picked.push(item);
    }
  }
  return picked;
}
