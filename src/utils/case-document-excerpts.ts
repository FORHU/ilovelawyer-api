import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { extractFacts } from "./fact-extract";

export type ReadyDoc = { id: string; name: string };

export type ChunkRow = { id: string; caseDocumentId: string; chunkText: string; chunkIndex: number; pageNumber: number | null };

/** Consecutive chunks of one document page, merged — what the pack samples. Some extractors cut
 * a PDF into one chunk per line (median ~80 characters), so a chunk on its own is too small to
 * say anything; a passage is sized in characters instead. */
export type Passage = { id: string; caseDocumentId: string; pageNumber: number | null; chunkIds: string[]; text: string };

// Total passages sampled across every ready document for one generation call (Case Strategy,
// Case Finding, Case Reconstruction, Evidence Intelligence, the case mind map). Budgeted
// per-document below, not as a flat case-wide top-K — see allocatePerDocumentBudget's docstring.
// TOTAL_PASSAGE_BUDGET passages of PASSAGE_CHARS plus their `[<documentId> p.N]` headers fit inside
// TEXT_CAP_CHARS, so the cap never cuts off the last documents' passages.
const TOTAL_PASSAGE_BUDGET = 48;
export const PASSAGE_CHARS = 800;
const TEXT_CAP_CHARS = 42000;

/** A short chunk whose text (digits ignored) appears on this many different pages is a banner or a
 * running header ("BUNDLE DOCUMENT 05 OF 21 …", "R v Doyle | … p.3"), not content. */
const BOILERPLATE_MIN_PAGES = 3;
const BOILERPLATE_MAX_CHARS = 200;

// UK forms extractFacts doesn't read (it knows ISO, "September 12, 2026" and PHP amounts): without
// them a UK document's body has almost no "fact" passages, and the preference below picked
// whatever header happened to carry an ISO date.
const UK_DATE_RE =
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i;
const OTHER_AMOUNT_RE = /[£$€]\s?\d/;

/** Every ready document gets an even floor share of the passage budget before any leftover budget
 * is handed out — a case with many documents no longer lets a few large/fact-dense exhibits
 * crowd out every sample slot from smaller or numerically-sparse ones (e.g. an admission letter
 * with no dollar figures or dates in it, sitting next to a financial ledger with hundreds of
 * pages). Within each document, passages that mention a date or an amount are preferred over the
 * rest of that SAME document's passages; a document with none still gets sampled from all of its
 * own. Banners and running headers are dropped first (dropBoilerplate), so they can't fill a
 * document's share. */
export async function buildFactExcerptPack(ready: ReadyDoc[]): Promise<{ chunkIds: string[]; text: string; factCount: number }> {
  if (ready.length === 0) return { chunkIds: [], text: "", factCount: 0 };

  const rowsByDoc: ChunkRow[][] = [];
  for (const doc of ready) {
    const ids = await DocumentChunkRepo.findIdsByDocument(doc.id);
    rowsByDoc.push(await DocumentChunkRepo.findTextsByIds(ids));
  }
  const boilerplate = boilerplateKeys(rowsByDoc.flat());

  let factCount = 0;
  const pools: Passage[][] = [];
  for (const rows of rowsByDoc) {
    const kept = rows.filter((row) => !boilerplate.has(boilerplateKey(row.chunkText)));
    // A document that is nothing but repeated header text still gets sampled from what it has.
    const passages = toPassages(kept.length ? kept : rows);
    const factPassages = passages.filter((p) => mentionsFact(p.text));
    factCount += factPassages.length;
    pools.push(factPassages.length > 0 ? factPassages : passages);
  }

  // Within each document, in reading order.
  const chosen = allocatePerDocumentBudget(pools, TOTAL_PASSAGE_BUDGET).flatMap((picked, i) =>
    [...picked].sort((a, b) => pools[i].indexOf(a) - pools[i].indexOf(b)),
  );

  const text = chosen
    .map((p) => `[${p.caseDocumentId}${p.pageNumber != null ? ` p.${p.pageNumber}` : ""}]\n${p.text}`)
    .join("\n\n")
    .slice(0, TEXT_CAP_CHARS);

  return { chunkIds: chosen.flatMap((p) => p.chunkIds), text, factCount };
}

function boilerplateKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Texts of short chunks that repeat across BOILERPLATE_MIN_PAGES or more distinct pages. */
export function boilerplateKeys(rows: ChunkRow[]): Set<string> {
  const pages = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.chunkText.length > BOILERPLATE_MAX_CHARS) continue;
    const key = boilerplateKey(row.chunkText);
    if (!key) continue;
    const seen = pages.get(key) ?? new Set<string>();
    seen.add(`${row.caseDocumentId}:${row.pageNumber ?? ""}`);
    pages.set(key, seen);
  }
  return new Set([...pages].filter(([, seen]) => seen.size >= BOILERPLATE_MIN_PAGES).map(([key]) => key));
}

/** One document's chunks merged, in chunkIndex order, into passages of about PASSAGE_CHARS that
 * never span a page break (so a passage's page citation stays exact). Each passage is capped at
 * PASSAGE_CHARS, so one oversized chunk can't take a bigger share of the prompt. */
export function toPassages(rows: ChunkRow[]): Passage[] {
  const out: Passage[] = [];
  let current: Passage | null = null;
  for (const row of [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    const text = row.chunkText.trim();
    if (!text) continue;
    if (!current || current.pageNumber !== row.pageNumber || current.text.length >= PASSAGE_CHARS) {
      current = { id: row.id, caseDocumentId: row.caseDocumentId, pageNumber: row.pageNumber, chunkIds: [], text: "" };
      out.push(current);
    }
    current.chunkIds.push(row.id);
    current.text = current.text ? `${current.text}\n${text}` : text;
  }
  for (const p of out) p.text = p.text.slice(0, PASSAGE_CHARS);
  return out;
}

export function mentionsFact(text: string): boolean {
  return UK_DATE_RE.test(text) || OTHER_AMOUNT_RE.test(text) || extractFacts(text).length > 0;
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
