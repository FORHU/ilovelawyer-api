import type { MindMapItem } from "./response-parser";

/**
 * Case map citations. The model is shown each case document under a short handle (D1, D2, …)
 * rather than its 36-character id: long ids come back garbled often enough that most citations
 * stopped matching a document (and, once every point must cite one, the map came back empty).
 * resolveCaseSources maps whatever the model wrote back to a real document id.
 */

export interface CaseDoc {
  id: string;
  name: string;
}

/** D1…Dn in the order given, so the same document list always gets the same handles. */
export function documentHandles(docs: CaseDoc[]): Map<string, CaseDoc> {
  return new Map(docs.map((doc, i) => [`D${i + 1}`, doc]));
}

/** The documents as the prompt lists them: each one's handle in place of its id. */
export function docsForPrompt(docs: CaseDoc[]): CaseDoc[] {
  return [...documentHandles(docs)].map(([handle, doc]) => ({ id: handle, name: doc.name }));
}

/** Rewrites the excerpt pack's `[<documentId> p.N]` headers to `[D<n> p.N]`. */
export function excerptsWithHandles(text: string, docs: CaseDoc[]): string {
  let out = text;
  for (const [handle, doc] of documentHandles(docs)) out = out.split(`[${doc.id}`).join(`[${handle}`);
  return out;
}

const UUID_PREFIX_MIN = 8;
const stripExtension = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The case document a citation means, or null. Accepts the handle (`D3`, `[D3]`, `d3`), the exact
 * id, an unambiguous id prefix of at least 8 characters (a garbled tail), or the document's name
 * with or without its extension.
 */
export function resolveDocumentRef(raw: string, docs: CaseDoc[]): string | null {
  const value = raw.trim().replace(/^\[|\]$/g, "").trim();
  if (!value) return null;
  const handle = /^d(\d+)$/i.exec(value);
  if (handle) return documentHandles(docs).get(`D${Number(handle[1])}`)?.id ?? null;
  const exact = docs.find((d) => d.id === value);
  if (exact) return exact.id;
  if (value.length >= UUID_PREFIX_MIN) {
    const prefix = value.slice(0, UUID_PREFIX_MIN).toLowerCase();
    const byPrefix = docs.filter((d) => d.id.toLowerCase().startsWith(prefix));
    if (byPrefix.length === 1) return byPrefix[0]!.id;
  }
  const name = squash(value);
  const byName = docs.filter((d) => squash(d.name) === name || squash(stripExtension(d.name)) === name);
  return byName.length === 1 ? byName[0]!.id : null;
}

/**
 * Replaces every node's cited document with the real id it refers to, and drops citations that
 * match no case document (a citation repeated after resolving is kept once). Mutates `tree`.
 * Returns how many were dropped and a few of the unmatched values, for the build log.
 */
export function resolveCaseSources(tree: MindMapItem, docs: CaseDoc[]): { dropped: number; unmatched: string[] } {
  let dropped = 0;
  const unmatched: string[] = [];
  const walk = (node: MindMapItem) => {
    if (node.sources) {
      const seen = new Set<string>();
      const kept = [];
      for (const source of node.sources) {
        const id = resolveDocumentRef(source.documentId, docs);
        if (!id) {
          dropped += 1;
          if (unmatched.length < 5) unmatched.push(source.documentId);
          continue;
        }
        const key = `${id}:${source.page ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(source.page ? { documentId: id, page: source.page } : { documentId: id });
      }
      if (kept.length) node.sources = kept;
      else delete node.sources;
    }
    node.children.forEach(walk);
  };
  walk(tree);
  return { dropped, unmatched };
}

/** An expanded point's citations as the model wrote them, resolved to real document ids;
 * anything that matches no case document is dropped. */
export function resolveRawSources(raw: unknown[] | undefined, docs: CaseDoc[]): { documentId: string; page?: number }[] {
  const out: { documentId: string; page?: number }[] = [];
  for (const item of raw ?? []) {
    const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const ref = typeof item === "string" ? item : (obj?.documentId ?? obj?.id ?? obj?.doc ?? obj?.document);
    const id = typeof ref === "string" ? resolveDocumentRef(ref, docs) : null;
    if (!id) continue;
    const page = Number(obj?.page);
    out.push(Number.isInteger(page) && page > 0 ? { documentId: id, page } : { documentId: id });
  }
  return out;
}

/** Passages as an expand prompt's EXTRACTED TEXT: each headed `[D<n> p.N]` with its document's
 * handle, passages from documents outside `docs` left out, each and the whole capped. */
export function excerptBlock(
  rows: { caseDocumentId: string; chunkText: string; pageNumber: number | null }[],
  docs: CaseDoc[],
  { perPassage = 700, total = 8000 } = {},
): string {
  const handleOf = new Map([...documentHandles(docs)].map(([handle, doc]) => [doc.id, handle]));
  return rows
    .filter((row) => handleOf.has(row.caseDocumentId))
    .map((row) => `[${handleOf.get(row.caseDocumentId)}${row.pageNumber != null ? ` p.${row.pageNumber}` : ""}]\n${row.chunkText.slice(0, perPassage)}`)
    .join("\n\n")
    .slice(0, total);
}
