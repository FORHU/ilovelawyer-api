import prisma from "../lib/prisma";
import { redis } from "../lib/redis";
import DocumentChunkRepo, { DocumentChunkRow } from "../repositories/document-chunk.repository";
import HttpError from "../utils/http-error";
import { RagStatus } from "@prisma/client";

const CACHE_TTL_S = 300; // 5 minutes
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
}
