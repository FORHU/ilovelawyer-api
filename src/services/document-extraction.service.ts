import { Prisma, RagStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { emitToUser, type DocumentSocketEvent, type DocumentSocketPayload } from "../lib/socket";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import OrganizationRepo from "../repositories/organization.repository";
import { getObjectBuffer } from "../utils/s3";
import { extractPages } from "../utils/document-text-extraction";
import { transcribeS3Media } from "./transcription.service";
import { MEDIA_DOCUMENT_EXTENSIONS, MEDIA_DOCUMENT_MIME_TYPES } from "../constants";
import { chunkPages, resolveChunkingProfile } from "../utils/chunking";
import { embedTexts, isRateLimit } from "../utils/embedding";
import { categorizeDocument } from "../utils/chatWonder";
import logger from "../utils/logger";

/** mp3/mp4 evidence — transcribed via AWS Transcribe rather than text-extracted. */
function isMediaDocument(mimeType?: string | null, filename?: string): boolean {
  if (mimeType && MEDIA_DOCUMENT_MIME_TYPES.includes(mimeType)) return true;
  const ext = filename?.split(".").pop()?.toLowerCase();
  return !!ext && MEDIA_DOCUMENT_EXTENSIONS.includes(ext);
}

/**
 * Transcribes mp3/mp4 evidence. Music, sound effects and silent screen recordings complete
 * successfully in Transcribe but return zero words — an empty transcript would otherwise fall
 * into the "no text extracted" branch, mark the document FAILED, and get re-swept (and
 * re-transcribed, billably) forever. A short placeholder indexes it as a normal READY document
 * so the file is still findable by name and the case's evidence list isn't stuck on an error.
 */
async function transcribeMedia(s3Key: string, documentId: string, filename: string): Promise<string> {
  const transcript = (await transcribeS3Media(s3Key, `document-${documentId}`)).trim();
  if (transcript) return transcript;
  logger.info("Document extraction: media has no recognizable speech", { documentId, name: filename });
  return `[Audio/video file "${filename}" — no speech was detected, so there is no transcript to index.]`;
}

export default class DocumentExtractionSvc {
  /**
   * Best-effort live push to the uploader (same `user:<id>` room chat uses). Document.ragStatus
   * in the DB is the source of truth and the web app still reconciles from it, so a failed or
   * skipped emit only costs latency — it must never affect the job, hence the try/catch even
   * though emitToUser documents itself as never throwing.
   */
  private static emit(
    doc: { id: string; userId: string; caseId: string | null; consultationId: string | null },
    event: DocumentSocketEvent,
    ragStatus: RagStatus,
    extra: Pick<DocumentSocketPayload, "pageCount" | "category"> = {},
  ): void {
    try {
      const payload: DocumentSocketPayload = {
        documentId: doc.id,
        caseId: doc.caseId,
        consultationId: doc.consultationId,
        ragStatus,
        ...extra,
      };
      emitToUser(doc.userId, event, payload);
    } catch (err) {
      logger.warn("Document extraction: emitToUser failed, continuing without it", { err, event, documentId: doc.id });
    }
  }

  /** Writes ragStatus, then pushes `event`. `updateRagStatus` returns the row, so the emit needs
   * no extra query and works even where the document was never loaded (the catch block). Throws
   * exactly what updateRagStatus throws (e.g. P2025 for a deleted document) — no emit then. */
  private static async setStatus(documentId: string, ragStatus: RagStatus, event: DocumentSocketEvent): Promise<void> {
    const doc = await DocumentRepo.updateRagStatus(documentId, ragStatus);
    DocumentExtractionSvc.emit(doc, event, ragStatus);
  }

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
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      if (doc.ragStatus !== "PENDING") {
        await DocumentRepo.updateRagStatus(documentId, "PENDING");
      }

      logger.info("Document extraction: started", { documentId, name: doc.name });
      // Also resets a re-run FAILED row's badge back to "indexing" on a connected client.
      DocumentExtractionSvc.emit(doc, "document:started", "PENDING");

      // Stage timings — the only way to tell "this document is slow because of OCR/rate
      // limiting/queue backlog" apart from each other after the fact, since none of that
      // showed up as elapsed time anywhere before this.
      const tStart = Date.now();
      // mp3/mp4 evidence has no text layer — transcribe it with AWS Transcribe (the same helpers
      // the Transcription page uses, reading straight from S3 so the file is never buffered here)
      // and index the transcript through the normal pipeline below. A failed/timed-out job throws,
      // which the catch at the bottom resolves to ragStatus FAILED.
      const isMedia = isMediaDocument(doc.mimeType, doc.name);
      const buffer = isMedia ? null : await getObjectBuffer(doc.file.s3Key);
      const tDownloaded = Date.now();
      const { pages, method, ocrAttempted } = buffer
        ? await extractPages(buffer, doc.mimeType, doc.name, doc.file.s3Key)
        : {
            pages: [{ pageNumber: 1, text: await transcribeMedia(doc.file.s3Key, documentId, doc.name) }],
            method: "text" as const,
            ocrAttempted: false,
          };
      const tExtracted = Date.now();
      logger.info("Document extraction: timing (download, extract)", {
        documentId,
        downloadMs: tDownloaded - tStart,
        extractMs: tExtracted - tDownloaded,
        method,
        ocrAttempted,
        pageCount: pages.length,
      });
      const trimmedPages = pages.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text.length > 0);

      await DocumentRepo.updateExtractionMeta(documentId, {
        pageCount: pages.length,
        extractionMethod: method,
        ocrAttempted,
      });

      // Empty extraction (scanned PDF with failed OCR) counts as failed, not ready.
      if (trimmedPages.length === 0) {
        logger.warn("Document extraction: no text extracted", { documentId, name: doc.name, ocrAttempted });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      // Kicked off now (not awaited) so it runs alongside chunking/embedding below rather
      // than adding its own latency to the pipeline — independent of chunk storage, so a
      // failure here (already swallowed inside categorizeDocument) never affects ragStatus.
      // Sliced to what Chat Wonder's categorization prompt actually reads (first 3000
      // chars) so a large document doesn't ship its full text over the wire for nothing.
      // Skipped entirely when the client already supplied a category (e.g. uploaded straight
      // into a folder) — that choice must stick, not get silently overwritten once this resolves.
      let categoryPromise: Promise<string | null>;
      if (doc.category?.trim()) {
        logger.info("Document extraction: skipping auto-categorization, category already set", {
          documentId,
          category: doc.category,
        });
        categoryPromise = Promise.resolve(null);
      } else {
        categoryPromise = categorizeDocument(
          trimmedPages.map((p) => p.text).join("\n\n").slice(0, 3000),
          doc.name,
        );
      }

      const totalChars = trimmedPages.reduce((sum, page) => sum + page.text.length, 0);
      const profile = resolveChunkingProfile({
        pageCount: pages.length,
        totalChars,
        fileSizeBytes: doc.fileSize ?? null,
      });
      const chunks = chunkPages(trimmedPages, profile);
      const tChunked = Date.now();
      if (chunks.length === 0) {
        logger.warn("Document extraction: no chunks", { documentId, name: doc.name });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
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

      const tEmbedded = Date.now();

      // Default interactive-transaction timeout (5s) is tuned for small transactions; a document
      // with tens of thousands of chunks needs the storage step to run considerably longer.
      await prisma.$transaction(
        async (tx) => {
          await DocumentChunkRepo.deleteByDocument(documentId, tx);
          await DocumentChunkRepo.insertMany(embeddedChunks, tx);
        },
        { timeout: Math.min(600_000, Math.max(120_000, chunks.length * 40)) },
      );
      const tStored = Date.now();
      logger.info("Document extraction: timing (chunk, embed, store)", {
        documentId,
        chunkMs: tChunked - tExtracted,
        embedMs: tEmbedded - tChunked,
        storeMs: tStored - tEmbedded,
        totalMs: tStored - tStart,
        chunks: chunks.length,
      });

      const { chunkCount, embeddedCount } = await DocumentChunkRepo.verify(documentId);
      if (chunkCount !== embeddedChunks.length || embeddedCount !== chunkCount) {
        logger.error("Document extraction: chunk verification mismatch", {
          documentId,
          expected: embeddedChunks.length,
          chunkCount,
          embeddedCount,
        });
        await DocumentExtractionSvc.setStatus(documentId, "FAILED", "document:failed");
        return;
      }

      await DocumentRepo.updateRagStatus(documentId, "READY");
      logger.info("Document extraction: ready", { documentId, name: doc.name, chunks: embeddedChunks.length });

      const category = await categoryPromise;
      let savedCategory: string | null = doc.category ?? null;
      if (category) {
        await DocumentRepo.updateCategory(documentId, category)
          .then(() => {
            savedCategory = category;
          })
          .catch((categoryErr) => {
            logger.warn("Failed to save document category", { categoryErr, documentId });
          });
      }

      // After the category write (not right after READY) so a client that refetches on this
      // event already sees the category. The DB row has been READY since a moment ago, so a
      // client that polls instead loses nothing.
      DocumentExtractionSvc.emit(doc, "document:ready", "READY", { pageCount: pages.length, category: savedCategory });

      if (doc.caseId) {
        // Best-effort — must never bubble into the outer catch and flip an already-READY
        // document back to FAILED just because the audit-log insert failed.
        await OrganizationRepo.writeAudit({
          caseId: doc.caseId,
          action: "document.ready",
          payload: { id: documentId, name: doc.name },
        }).catch((auditErr) => {
          logger.warn("Failed to write document.ready audit event", { auditErr, documentId });
        });

        const { scheduleCasePostExtraction } = await import("../queues/case-post-extraction");
        scheduleCasePostExtraction(doc.caseId, doc.userId);
      }
    } catch (err) {
      logger.error("Document extraction failed", { err, documentId });
      // 429 is transient — leave PENDING so the next boot/retry can embed instead of
      // permanently skipping RAG for this document.
      const ragStatus = isRateLimit(err) ? "PENDING" : "FAILED";
      await DocumentExtractionSvc.setStatus(
        documentId,
        ragStatus,
        ragStatus === "PENDING" ? "document:retrying" : "document:failed",
      ).catch((updateErr) => {
        // P2025: the document was deleted (or its user/org cascaded away) while extraction
        // was still in flight — expected race with delete, not a real failure to surface.
        if (updateErr instanceof Prisma.PrismaClientKnownRequestError && updateErr.code === "P2025") {
          logger.info("Skipped ragStatus update: document no longer exists", { documentId, ragStatus });
          return;
        }
        logger.error("Failed to update ragStatus after extraction error", { updateErr, documentId, ragStatus });
      });
    }
  }
}
