import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import DocumentChunkRepo, { DocumentChunkRow } from "../repositories/document-chunk.repository";
import HttpError from "../utils/http-error";
import { embedText } from "../utils/embedding";
import { rank as bm25Rank } from "../utils/bm25";
import { RagStatus } from "@prisma/client";
import { OMIT_EMBEDDING_RANKING } from "../constants";
import logger from "../utils/logger";

const CACHE_TTL_S = 300; // 5 minutes
// Per-document chunk floor, not a case-wide chunk count — see findRelevantByCase's docstring.
// A flat case-wide count (the old DEFAULT_CASE_CHUNK_LIMIT = 20) let a case with many documents
// silently exclude whole documents whose chunks didn't win a case-wide top-K slot.
const DEFAULT_PER_DOCUMENT_CHUNK_FLOOR = 3;
// Unrelated to the floor above — this is a single document's own top-K when it's the sole
// grounding source (relevantChunksForDocument), where the "many documents crowd out a few"
// failure mode this plan targets doesn't apply.
const DEFAULT_SINGLE_DOCUMENT_CHUNK_LIMIT = 20;
const cacheKey = (caseDocumentId: string) => `case_document_chunks:${caseDocumentId}`;
const filterCacheKey = (filter: { caseId?: string; consultationId?: string }) =>
  filter.caseId ? `case_document_chunks:case:${filter.caseId}` : `case_document_chunks:consultation:${filter.consultationId}`;

export interface DocumentWithChunks {
  caseDocumentId: string;
  name: string;
  caseId: string | null;
  ragStatus: RagStatus;
  chunks: DocumentChunkRow[];
}

/** Shape chat-wonder expects: document ids to prefetch + ranked chunk ids to filter each fetch. */
export interface RelevantCaseChunks {
  caseDocumentIds: string[];
  caseDocumentChunkIds: string[];
}

export default class DocumentChunkSvc {
  /**
   * query, when given, BM25-ranks the document's chunks by relevance to it — reordering only,
   * nothing is dropped. The cached/fetched result is always built and stored in natural
   * chunkIndex order regardless of query, so a ranked request and an unranked request for the
   * same document still share one cache entry and one DB read; ranking only reorders the copy
   * handed back to this particular caller.
   *
   * This is what chat-wonder-v2-api's get_case_document now calls (passing the current
   * question as query) instead of running its own BM25 pass locally after fetching the whole
   * document — see that function's docstring for how it decides whether to keep this order
   * (about to truncate) or fall back to chunkIndex order (nothing will be cut, so there's
   * nothing to gain by disturbing reading order).
   */
  static async listByDocument(caseDocumentId: string, query?: string): Promise<DocumentWithChunks> {
    const key = cacheKey(caseDocumentId);

    let result = await redis.get<DocumentWithChunks>(key);
    if (result) {
      logger.info("Case document: cache hit", { caseDocumentId, chunks: result.chunks.length });
    } else {
      logger.info("Case document: cache miss, fetching from DB", { caseDocumentId });
      const doc = await prisma.document.findUnique({
        where: { id: caseDocumentId },
        select: { id: true, name: true, caseId: true, ragStatus: true, status: true },
      });
      if (!doc) {
        logger.warn("Case document: not found", { caseDocumentId });
        throw new HttpError("Case document not found", 404);
      }
      // Option A of the "Archived Documents in Chat" plan — an archived document is unreachable
      // here too, not just excluded from auto-selection (relevantChunksForScope) and explicit
      // attachment (ChatSvc.scopedCaseDocumentId). Treated as 404 rather than a silent empty
      // result: this is chat-wonder's own get_case_document callback, requesting a document id it
      // was already told about — a 404 here is a real, actionable signal, not a degraded fallback.
      if (doc.status === "ARCHIVED") {
        logger.warn("Case document: archived, refusing", { caseDocumentId });
        throw new HttpError("Case document not found", 404);
      }

      const chunks = await DocumentChunkRepo.findByDocument(caseDocumentId);
      result = {
        caseDocumentId: doc.id,
        name: doc.name,
        caseId: doc.caseId,
        ragStatus: doc.ragStatus,
        chunks,
      };
      logger.info("Case document: fetched from DB", { caseDocumentId, chunks: chunks.length, ragStatus: doc.ragStatus });
      await redis.set(key, result, CACHE_TTL_S);
    }

    const { chunks } = result;
    if (!query || !chunks.length) return result;

    const order = bm25Rank(
      chunks.map((c) => c.chunkText),
      query,
    );
    logger.info("Case document: BM25 rerank", {
      caseDocumentId,
      chunks: chunks.length,
      topChunkId: chunks[order[0]]?.id,
    });
    return { ...result, chunks: order.map((i) => chunks[i]) };
  }

  /** Same shape as `listByDocument`, but scoped to every document under a case or a consultation
   * rather than a single document id — lets Chat Wonder pull RAG context for a whole case (or a
   * pre-case consultation) in one call instead of one request per caseDocumentId. */
  static async listByCaseOrConsultation(filter: { caseId?: string; consultationId?: string }): Promise<DocumentWithChunks[]> {
    const key = filterCacheKey(filter);

    const cached = await redis.get<DocumentWithChunks[]>(key);
    if (cached) return cached;

    // status: "ACTIVE" — same Option A exclusion as listByDocument/relevantChunksForScope, kept
    // consistent across every document-selection entry point chat-wonder can reach.
    const docs = await prisma.document.findMany({
      where: filter.caseId
        ? { caseId: filter.caseId, status: "ACTIVE" }
        : { consultationId: filter.consultationId, status: "ACTIVE" },
      select: { id: true, name: true, caseId: true, ragStatus: true },
      orderBy: { createdAt: "desc" },
    });

    const result: DocumentWithChunks[] = await Promise.all(
      docs.map(async (doc) => ({
        caseDocumentId: doc.id,
        name: doc.name,
        caseId: doc.caseId,
        ragStatus: doc.ragStatus,
        chunks: await DocumentChunkRepo.findByDocument(doc.id),
      })),
    );

    await redis.set(key, result, CACHE_TTL_S);
    return result;
  }

  /**
   * Rank READY document chunks by similarity to `query` and return the chat-wonder
   * payload fields. On embedding/search failure, falls back to every READY document id with
   * an empty chunk-id list (chat-wonder then loads full document text).
   */
  static async relevantChunksForCase(
    caseId: string,
    query: string,
    perDocumentFloor = DEFAULT_PER_DOCUMENT_CHUNK_FLOOR,
  ): Promise<RelevantCaseChunks> {
    return DocumentChunkSvc.relevantChunksForScope({ caseId }, query, perDocumentFloor);
  }

  /** Same as `relevantChunksForCase`, but for documents attached to a consultation. */
  static async relevantChunksForConsultation(
    consultationId: string,
    query: string,
    perDocumentFloor = DEFAULT_PER_DOCUMENT_CHUNK_FLOOR,
  ): Promise<RelevantCaseChunks> {
    return DocumentChunkSvc.relevantChunksForScope({ consultationId }, query, perDocumentFloor);
  }

  private static async relevantChunksForScope(
    scope: { caseId: string } | { consultationId: string },
    query: string,
    perDocumentFloor: number,
  ): Promise<RelevantCaseChunks> {
    // status: "ACTIVE" keeps an archived document out of auto-selection — archiving elsewhere in
    // the app is a pure visibility flag with no effect on RAG, but grounding is the one place we
    // deliberately opt out of that rule (see the "Archived Documents in Chat" plan, Option A: full
    // exclusion). This only closes the auto-selection door — an explicit reference is blocked
    // separately in ChatSvc.scopedCaseDocumentId.
    const where =
      "caseId" in scope
        ? { caseId: scope.caseId, ragStatus: "READY" as const, status: "ACTIVE" as const }
        : { consultationId: scope.consultationId, ragStatus: "READY" as const, status: "ACTIVE" as const };

    // Every READY document in scope must end up in caseDocumentIds regardless of whether the
    // relevance ranking below picked any of its chunks — the ranking governs what's pre-filled
    // as chunk ids, not which documents chat-wonder is allowed to know about/fetch on its own.
    const readyDocs = await prisma.document.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    const readyDocIds = readyDocs.map((d) => d.id);
    if (!readyDocIds.length) return { caseDocumentIds: [], caseDocumentChunkIds: [] };
    if (OMIT_EMBEDDING_RANKING) return { caseDocumentIds: readyDocIds, caseDocumentChunkIds: [] };

    try {
      const queryEmbedding = await embedText(query);
      const rows =
        "caseId" in scope
          ? await DocumentChunkRepo.findRelevantByCase(scope.caseId, queryEmbedding, perDocumentFloor)
          : await DocumentChunkRepo.findRelevantByConsultation(scope.consultationId, queryEmbedding, perDocumentFloor);
      return {
        caseDocumentIds: readyDocIds,
        // Already similarity-desc (and globally capped) from findRelevantByCase/Consultation —
        // formatGroundingContext relies on this order when filling the char budget.
        caseDocumentChunkIds: rows.map((r) => r.id),
      };
    } catch {
      return {
        caseDocumentIds: readyDocIds,
        caseDocumentChunkIds: [],
      };
    }
  }

  /** Rank chunks for one READY document (same shape as case/consultation helpers). */
  static async relevantChunksForDocument(
    caseDocumentId: string,
    query: string,
    limit = DEFAULT_SINGLE_DOCUMENT_CHUNK_LIMIT,
  ): Promise<RelevantCaseChunks> {
    if (OMIT_EMBEDDING_RANKING) {
      return { caseDocumentIds: [caseDocumentId], caseDocumentChunkIds: [] };
    }
    try {
      const queryEmbedding = await embedText(query);
      const chunkIds = await DocumentChunkRepo.findRelevantByDocument(caseDocumentId, queryEmbedding, limit);
      return { caseDocumentIds: chunkIds.length ? [caseDocumentId] : [], caseDocumentChunkIds: chunkIds };
    } catch {
      const chunkIds = await DocumentChunkRepo.findIdsByDocument(caseDocumentId);
      return {
        caseDocumentIds: chunkIds.length ? [caseDocumentId] : [],
        caseDocumentChunkIds: chunkIds.slice(0, limit),
      };
    }
  }

  /**
   * Build plain-text document context from ranked chunks so chat-wonder can analyze
   * attachments even when its callback to GET /case-document fails (wrong base URL / API key).
   */
  static async formatGroundingContext(
    grounding: { caseDocumentIds: string[]; caseDocumentChunkIds?: string[] },
    charCap = 12_000,
    scope?: { caseId?: string; consultationId?: string },
  ): Promise<string> {
    if (!grounding.caseDocumentIds.length) return "";

    let chunkIds = grounding.caseDocumentChunkIds ?? [];
    if (!chunkIds.length && grounding.caseDocumentIds.length === 1) {
      chunkIds = await DocumentChunkRepo.findIdsByDocument(grounding.caseDocumentIds[0]);
    }
    if (!chunkIds.length) return "";

    const rows = await DocumentChunkRepo.findTextsByIds(chunkIds);
    if (!rows.length) return "";

    const allowedDocIds = new Set(grounding.caseDocumentIds);
    const docs = await prisma.document.findMany({
      where: {
        id: { in: [...allowedDocIds] },
        ...(scope?.caseId || scope?.consultationId
          ? {
              OR: [
                ...(scope.caseId ? [{ caseId: scope.caseId }] : []),
                ...(scope.consultationId ? [{ consultationId: scope.consultationId }] : []),
              ],
            }
          : {}),
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(docs.map((d) => [d.id, d.name]));
    const scopedDocIds = new Set(docs.map((d) => d.id));

    // `rows` is already in caseDocumentChunkIds order, which relevantChunksForScope fills
    // similarity-desc. Walk that order so the 12k cap is spent on the closest pages, not
    // whichever document happened to land first in a Map.
    const blocks: string[] = [];
    let used = 0;
    for (const row of rows) {
      if (!scopedDocIds.has(row.caseDocumentId) || !allowedDocIds.has(row.caseDocumentId)) continue;
      // Name only, never the id: an id printed here is an id the AI can echo into its answer or
      // its Decision Records, where a user then reads it. (Chat Wonder still gets the ids it needs
      // through its own manifest; this text is for reading, not for fetching.)
      const name = nameById.get(row.caseDocumentId)?.trim() || "Untitled document";
      const header = `Document "${name}" (page ${row.pageNumber ?? "?"}):`;
      let body = row.chunkText;
      const room = charCap - used - header.length - 2;
      if (room <= 0) break;
      if (body.length > room) body = `${body.slice(0, room).trimEnd()}\n\n[...truncated...]`;
      blocks.push(`${header}\n${body}`);
      used += header.length + body.length + 2;
    }

    if (!blocks.length) return "";
    return (
      "[CASE DOCUMENTS — files the user uploaded. Reference them directly when relevant; " +
      "do NOT treat them as public legal precedent. Do not ask the user to re-upload these files. " +
      "Refer to each file by its name; never write a file id.]\n\n" +
      blocks.join("\n\n")
    );
  }

  /** Busts listByDocument's per-document cache entry and listByCaseOrConsultation's per-scope
   * one for a document that just changed status — without this, archiving/unarchiving wouldn't
   * take effect for chat-wonder's callback endpoints until the existing 5-minute TTL expired on
   * its own (see CACHE_TTL_S). Best-effort: redis.del already swallows a down/unready client. */
  static async invalidateCacheForDocument(doc: { id: string; caseId: string | null; consultationId: string | null }): Promise<void> {
    await Promise.all([
      redis.del(cacheKey(doc.id)),
      doc.caseId ? redis.del(filterCacheKey({ caseId: doc.caseId })) : Promise.resolve(),
      doc.consultationId ? redis.del(filterCacheKey({ consultationId: doc.consultationId })) : Promise.resolve(),
    ]);
  }
}
