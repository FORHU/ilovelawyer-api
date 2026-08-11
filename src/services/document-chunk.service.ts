import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import DocumentChunkRepo, { DocumentChunkRow } from "../repositories/document-chunk.repository";
import HttpError from "../utils/http-error";
import { embedText } from "../utils/embedding";
import { RagStatus } from "@prisma/client";

const CACHE_TTL_S = 300; // 5 minutes
const DEFAULT_CASE_CHUNK_LIMIT = 20;
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
  static async listByDocument(caseDocumentId: string): Promise<DocumentWithChunks> {
    const key = cacheKey(caseDocumentId);

    const cached = await redis.get<DocumentWithChunks>(key);
    if (cached) return cached;

    const doc = await prisma.document.findUnique({
      where: { id: caseDocumentId },
      select: { id: true, name: true, caseId: true, ragStatus: true },
    });
    if (!doc) throw new HttpError("Case document not found", 404);

    const chunks = await DocumentChunkRepo.findByDocument(caseDocumentId);
    const result: DocumentWithChunks = {
      caseDocumentId: doc.id,
      name: doc.name,
      caseId: doc.caseId,
      ragStatus: doc.ragStatus,
      chunks,
    };
    await redis.set(key, result, CACHE_TTL_S);
    return result;
  }

  /** Same shape as `listByDocument`, but scoped to every document under a case or a consultation
   * rather than a single document id — lets Chat Wonder pull RAG context for a whole case (or a
   * pre-case consultation) in one call instead of one request per caseDocumentId. */
  static async listByCaseOrConsultation(filter: { caseId?: string; consultationId?: string }): Promise<DocumentWithChunks[]> {
    const key = filterCacheKey(filter);

    const cached = await redis.get<DocumentWithChunks[]>(key);
    if (cached) return cached;

    const docs = await prisma.document.findMany({
      where: filter.caseId ? { caseId: filter.caseId } : { consultationId: filter.consultationId },
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
    limit = DEFAULT_CASE_CHUNK_LIMIT,
  ): Promise<RelevantCaseChunks> {
    return DocumentChunkSvc.relevantChunksForScope({ caseId }, query, limit);
  }

  /** Same as `relevantChunksForCase`, but for documents attached to a consultation. */
  static async relevantChunksForConsultation(
    consultationId: string,
    query: string,
    limit = DEFAULT_CASE_CHUNK_LIMIT,
  ): Promise<RelevantCaseChunks> {
    return DocumentChunkSvc.relevantChunksForScope({ consultationId }, query, limit);
  }

  private static async relevantChunksForScope(
    scope: { caseId: string } | { consultationId: string },
    query: string,
    limit: number,
  ): Promise<RelevantCaseChunks> {
    const where =
      "caseId" in scope
        ? { caseId: scope.caseId, ragStatus: "READY" as const }
        : { consultationId: scope.consultationId, ragStatus: "READY" as const };

    try {
      const queryEmbedding = await embedText(query);
      const rows =
        "caseId" in scope
          ? await DocumentChunkRepo.findRelevantByCase(scope.caseId, queryEmbedding, limit)
          : await DocumentChunkRepo.findRelevantByConsultation(scope.consultationId, queryEmbedding, limit);
      const caseDocumentIds = [...new Set(rows.map((r) => r.caseDocumentId))];
      return {
        caseDocumentIds,
        caseDocumentChunkIds: rows.map((r) => r.id),
      };
    } catch {
      const docs = await prisma.document.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      return {
        caseDocumentIds: docs.map((d) => d.id),
        caseDocumentChunkIds: [],
      };
    }
  }
}
