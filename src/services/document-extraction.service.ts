import prisma from "../lib/prisma";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { getObjectBuffer } from "../utils/s3";
import { extractPages } from "../utils/document-text-extraction";
import { chunkPages, resolveChunkingProfile } from "../utils/chunking";
import { embedTexts, isRateLimit } from "../utils/embedding";
import logger from "../utils/logger";

export default class DocumentExtractionSvc {
  /**
   * Extraction → chunking → embedding → storage pipeline for a Case Document (ADR 0010).
   * Pulled by `DocumentExtractionQueue` after confirm/PATCH/bulk-confirm — never throws,
   * always resolves ragStatus to READY or FAILED.
   */
  static async process(documentId: string): Promise<void> {
    try {
      const doc = await DocumentRepo.findByIdWithFile(documentId);
      if (!doc?.file?.s3Key) {
        logger.error("Document extraction: no file/s3Key for document", { documentId });
        await DocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      if (doc.ragStatus !== "PENDING") {
        await DocumentRepo.updateRagStatus(documentId, "PENDING");
      }

      logger.info("Document extraction: started", { documentId, name: doc.name });

      const buffer = await getObjectBuffer(doc.file.s3Key);
      const { pages, method, ocrAttempted } = await extractPages(buffer, doc.mimeType, doc.name);
      const trimmedPages = pages.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text.length > 0);

      await DocumentRepo.updateExtractionMeta(documentId, {
        pageCount: pages.length,
        extractionMethod: method,
        ocrAttempted,
      });

      // Empty extraction (scanned PDF with failed OCR) counts as failed, not ready.
      if (trimmedPages.length === 0) {
        logger.warn("Document extraction: no text extracted", { documentId, name: doc.name, ocrAttempted });
        await DocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      const totalChars = trimmedPages.reduce((sum, page) => sum + page.text.length, 0);
      const profile = resolveChunkingProfile({
        pageCount: pages.length,
        totalChars,
        fileSizeBytes: doc.fileSize ?? null,
      });
      const chunks = chunkPages(trimmedPages, profile);
      if (chunks.length === 0) {
        logger.warn("Document extraction: no chunks", { documentId, name: doc.name });
        await DocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      const embeddingBatchSize = profile.embeddingBatchSize;
      const embeddingConcurrency = profile.embeddingConcurrency;
      const batches: string[][] = [];
      for (let i = 0; i < chunks.length; i += embeddingBatchSize) {
        batches.push(chunks.slice(i, i + embeddingBatchSize).map((c) => c.text));
      }

      logger.info("Document extraction: embedding", {
        documentId,
        chunks: chunks.length,
        batches: batches.length,
        tier: profile.tier,
        chunkSize: profile.chunkSize,
        fileSizeBytes: doc.fileSize,
        pageCount: pages.length,
        totalChars,
      });

      const embeddedChunks: { caseDocumentId: string; chunkIndex: number; chunkText: string; charCount: number; embedding: number[]; pageNumber: number | null }[] = [];
      for (let i = 0; i < batches.length; i += embeddingConcurrency) {
        const group = batches.slice(i, i + embeddingConcurrency);
        const groupEmbeddings = await Promise.all(group.map((batch) => embedTexts(batch)));
        group.forEach((batch, g) => {
          const baseChunkIndex = (i + g) * embeddingBatchSize;
          batch.forEach((chunk, j) =>
            embeddedChunks.push({
              caseDocumentId: documentId,
              chunkIndex: baseChunkIndex + j,
              chunkText: chunk,
              charCount: chunk.length,
              embedding: groupEmbeddings[g][j],
              pageNumber: chunks[baseChunkIndex + j]?.pageNumber ?? null,
            }),
          );
        });
        logger.info("Document extraction: embedding progress", {
          documentId,
          completedBatches: Math.min(i + embeddingConcurrency, batches.length),
          totalBatches: batches.length,
          tier: profile.tier,
        });
      }

      // Default interactive-transaction timeout (5s) is tuned for small transactions; a document
      // with tens of thousands of chunks needs the storage step to run considerably longer.
      await prisma.$transaction(
        async (tx) => {
          await DocumentChunkRepo.deleteByDocument(documentId, tx);
          await DocumentChunkRepo.insertMany(embeddedChunks, tx);
        },
        { timeout: Math.min(600_000, Math.max(120_000, chunks.length * 40)) },
      );

      const { chunkCount, embeddedCount } = await DocumentChunkRepo.verify(documentId);
      if (chunkCount !== embeddedChunks.length || embeddedCount !== chunkCount) {
        logger.error("Document extraction: chunk verification mismatch", {
          documentId,
          expected: embeddedChunks.length,
          chunkCount,
          embeddedCount,
        });
        await DocumentRepo.updateRagStatus(documentId, "FAILED");
        return;
      }

      await DocumentRepo.updateRagStatus(documentId, "READY");
      logger.info("Document extraction: ready", { documentId, name: doc.name, chunks: embeddedChunks.length });

      if (doc.caseId) {
        const { scheduleCasePostExtraction } = await import("../queues/case-post-extraction");
        scheduleCasePostExtraction(doc.caseId);
      }
    } catch (err) {
      logger.error("Document extraction failed", { err, documentId });
      // 429 is transient — leave PENDING so the next boot/retry can embed instead of
      // permanently skipping RAG for this document.
      const ragStatus = isRateLimit(err) ? "PENDING" : "FAILED";
      await DocumentRepo.updateRagStatus(documentId, ragStatus).catch((updateErr) => {
        logger.error("Failed to update ragStatus after extraction error", { updateErr, documentId, ragStatus });
      });
    }
  }
}
