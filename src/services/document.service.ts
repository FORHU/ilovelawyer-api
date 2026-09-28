import crypto from "crypto";
import path from "path";
import prisma from "../lib/prisma";
import DocumentRepo from "../repositories/document.repository";
import FilesRepo from "../repositories/files.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import OrganizationRepo from "../repositories/organization.repository";
import DocumentChunkSvc from "./document-chunk.service";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import { s3UrlForKey, getPresignedUploadUrl, getProxyFileUrl, getObjectBuffer } from "../utils/s3";
import { extractText } from "../utils/document-text-extraction";
import HttpError from "../utils/http-error";
import { DOCUMENT_CONFIRM_TX_TIMEOUT_MS } from "../constants";
import { DocumentStatus } from "@prisma/client";

/** Flattens the related File row's fileUrl onto the Document, matching the Swagger `UserDocument`
 * contract (a top-level `fileUrl`, not a nested `file` object) — see docs/adr for the fileUrl gap
 * this closes: fileUrl was declared in the contract but no query ever included the File relation.
 * The bucket has no public-read policy (see utils/s3.ts), so a bare File.fileUrl 403s in a
 * browser anyway — this hands back a same-origin proxy link instead (see getProxyFileUrl), never
 * the stored fileUrl column, which may be a raw S3/CloudFront URL. Pre-migration rows with no
 * s3Key get null rather than that stored URL. */
export async function mapDocumentToDto<T extends { file?: { fileUrl: string | null; s3Key: string | null } | null }>(doc: T) {
  const { file, ...rest } = doc;
  const fileUrl = file?.s3Key ? getProxyFileUrl(file.s3Key) : null;
  return { ...rest, fileUrl };
}

export default class DocumentSvc {
  /** Key branches on whether caseId is known at presign time (ADR 0011): case-scoped when it is,
   * consultation-scoped when only a consultationId (Consultation.id) is known, user-scoped
   * otherwise (e.g. Document Analysis's "No Case" upload). consultationId is only used to build
   * the S3 key here — it isn't persisted on the Document row. The random shortId guards against
   * same-millisecond collisions when multiple files are presigned concurrently for the same
   * case/user (Create Case uploads pending files in a concurrency pool, then confirms in batches). */
  static async presign(userId: string, filename: string, contentType: string, caseId?: string, consultationId?: string) {
    const ext = path.extname(filename);
    const shortId = crypto.randomUUID().slice(0, 8);
    const key = caseId
      ? `documents/cases/${caseId}/${Date.now()}-${shortId}${ext}`
      : consultationId
        ? `documents/consultations/${consultationId}/${Date.now()}-${shortId}${ext}`
        : `documents/users/${userId}/${Date.now()}-${shortId}${ext}`;
    const uploadUrl = await getPresignedUploadUrl(key, contentType);
    return { uploadUrl, key };
  }

  static async presignMany(
    userId: string,
    files: { filename: string; contentType: string }[],
    caseId?: string,
    consultationId?: string,
  ) {
    return Promise.all(
      files.map((file) => this.presign(userId, file.filename, file.contentType, caseId, consultationId)),
    );
  }

  /** Creates the Document row for a file already uploaded to S3 via the presigned PUT from `presign()`.
   * Extraction/embedding is queued when either caseId or consultationId is given — a bare
   * upload with neither (e.g. Document Analysis's "No Case" flow) stays un-embedded, since nothing
   * will ever query it via chat RAG and there's no reason to pay for that OpenAI call. */
  static async create(
    organizationId: string,
    userId: string,
    data: { key: string; name: string; caseId?: string; consultationId?: string; contentType?: string; fileSize?: number },
  ) {
    const fileUrl = s3UrlForKey(data.key);
    const file = await FilesRepo.create(data.name, fileUrl, data.key);
    const doc = await DocumentRepo.create(organizationId, userId, {
      name: data.name,
      fileId: file.id,
      caseId: data.caseId,
      consultationId: data.consultationId,
      mimeType: data.contentType,
      fileSize: data.fileSize,
    });
    if (data.caseId || data.consultationId) DocumentExtractionQueue.enqueue(doc.id);
    return doc;
  }

  /** Bulk variant of `create()` — confirms several files uploaded to S3 in one transaction.
   * Extraction is queued when either caseId or consultationId is given. */
  static async createMany(
    organizationId: string,
    userId: string,
    items: { key: string; name: string; contentType?: string; fileSize?: number }[],
    caseId?: string,
    consultationId?: string,
  ) {
    const filesToCreate: Express.FileTypes[] = items.map((item) => ({
      filename: item.name,
      fileUrl: s3UrlForKey(item.key),
      s3Key: item.key,
    }));

    const { createdDocuments, files } = await prisma.$transaction(async (tx) => {
      const files = await FilesRepo.createFile(filesToCreate, tx);

      const userDocumentData = files.map((file, i) => ({
        organizationId,
        userId,
        caseId,
        consultationId,
        name: items[i].name,
        fileId: file.id,
        mimeType: items[i].contentType,
        fileSize: items[i].fileSize,
      }));

      const createdDocuments = await DocumentRepo.createManyAndReturn(userDocumentData, tx);
      return { createdDocuments, files };
    }, { timeout: DOCUMENT_CONFIRM_TX_TIMEOUT_MS });

    if (caseId || consultationId) {
      DocumentExtractionQueue.enqueueMany(createdDocuments.map((doc) => doc.id));
    }

    // createManyAndReturn can't `include` the File relation (see repo note), so fileUrl is
    // merged in here from the same-transaction `files`, which line up positionally with
    // `createdDocuments` since both were built from the same ordered `items` input.
    return Promise.all(
      createdDocuments.map(async (doc, i) => {
        const { s3Key } = files[i];
        return { ...doc, fileUrl: s3Key ? getProxyFileUrl(s3Key) : null };
      }),
    );
  }

  static async list(organizationId: string, status?: DocumentStatus) {
    const docs = await DocumentRepo.list(organizationId, status);
    return Promise.all(docs.map(mapDocumentToDto));
  }

  static async listByCase(organizationId: string, caseId: string, status?: DocumentStatus) {
    const docs = await DocumentRepo.listByCase(organizationId, caseId, status);
    return Promise.all(docs.map(mapDocumentToDto));
  }

  static async listByConsultation(organizationId: string, consultationId: string, status?: DocumentStatus) {
    const docs = await DocumentRepo.listByConsultation(organizationId, consultationId, status);
    return Promise.all(docs.map(mapDocumentToDto));
  }

  static async getById(id: string, organizationId: string) {
    const doc = await DocumentRepo.findById(id, organizationId);
    if (!doc) throw new HttpError("Document not found", 404);
    return mapDocumentToDto(doc);
  }

  /** Plain-text fallback preview for formats the browser has no rich in-app viewer for (legacy
   * .doc, chiefly — see AttachmentPreview on the frontend). Re-runs the same extraction the
   * indexing pipeline uses (document-text-extraction.ts) directly against the S3 bytes rather
   * than reading persisted CaseDocumentChunk rows, so it works immediately after upload without
   * waiting on (or depending on the success of) RAG extraction/chunking. */
  static async getTextPreview(id: string, organizationId: string) {
    const doc = await DocumentRepo.findById(id, organizationId);
    if (!doc) throw new HttpError("Document not found", 404);
    if (!doc.file?.s3Key) throw new HttpError("Document has no file", 404);

    const buffer = await getObjectBuffer(doc.file.s3Key);
    try {
      const text = await extractText(buffer, doc.mimeType, doc.name);
      return { text };
    } catch {
      throw new HttpError("Text preview not available for this file type", 400);
    }
  }

  static async update(id: string, organizationId: string, data: { name?: string; caseId?: string | null; consultationId?: string | null; isExhibit?: boolean }) {
    const updated = await DocumentRepo.update(id, organizationId, data);
    if (!updated) throw new HttpError("Document not found", 404);
    if (data.caseId || data.consultationId) DocumentExtractionQueue.enqueue(id);
  }

  /** Archiving/unarchiving is independent of delete. It moves the document between the Document
   * view's Active/Archived tabs and takes it out of (or back into) chat grounding (see
   * DocumentChunkSvc.relevantChunksForScope's ACTIVE filter). The case's analysis refresh
   * (findings, strategy, contradictions) still reads archived documents; the case mind map follows
   * chat instead and leaves them out, so both schedule the post-upload job, which rebuilds only the
   * map when only the map's document set moved (see runCasePostExtraction). */
  static async archive(id: string, organizationId: string, actorId: string) {
    const updated = await DocumentRepo.setStatus(id, organizationId, "ARCHIVED");
    if (!updated) throw new HttpError("Document not found", 404);
    await OrganizationRepo.writeAudit({ caseId: updated.caseId ?? undefined, actorId, action: "document.archive", payload: { documentId: id } });
    // Without this, chat-wonder's listByDocument/listByCaseOrConsultation callbacks would keep
    // serving this document out of Redis for up to CACHE_TTL_S after it's archived.
    await DocumentChunkSvc.invalidateCacheForDocument(updated);
    await DocumentSvc.scheduleMindMapResync(updated, actorId);
    return mapDocumentToDto(updated);
  }

  /** The post-upload job for an archived/unarchived case document that's indexed — see archive(). */
  private static async scheduleMindMapResync(doc: { caseId: string | null; ragStatus: string }, actorId: string) {
    if (!doc.caseId || doc.ragStatus !== "READY") return;
    const { scheduleCasePostExtraction } = await import("../queues/case-post-extraction");
    scheduleCasePostExtraction(doc.caseId, actorId);
  }

  static async unarchive(id: string, organizationId: string, actorId: string) {
    const updated = await DocumentRepo.setStatus(id, organizationId, "ACTIVE");
    if (!updated) throw new HttpError("Document not found", 404);
    await OrganizationRepo.writeAudit({ caseId: updated.caseId ?? undefined, actorId, action: "document.unarchive", payload: { documentId: id } });
    // Same reasoning as archive() above, in reverse — listByCaseOrConsultation's cached array
    // from while this document was excluded shouldn't linger past the moment it's restored.
    await DocumentChunkSvc.invalidateCacheForDocument(updated);
    await DocumentSvc.scheduleMindMapResync(updated, actorId);
    return mapDocumentToDto(updated);
  }

  /** Bulk "Select All" restore from the Archived documents view — same per-document path as
   * unarchive() (audit row + cache invalidation each), fanned out with allSettled so one missing/
   * already-active id doesn't fail the whole batch the user selected. */
  static async unarchiveMany(ids: string[], organizationId: string, actorId: string) {
    const results = await Promise.allSettled(ids.map((id) => this.unarchive(id, organizationId, actorId)));
    const succeeded: Awaited<ReturnType<typeof mapDocumentToDto>>[] = [];
    const failed: { id: string; error: string }[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") succeeded.push(result.value);
      else failed.push({ id: ids[i], error: result.reason instanceof Error ? result.reason.message : "Failed to restore document" });
    });
    return { succeeded, failed };
  }

  /** Cascades a Case's own archive into its documents (see CaseSvc.archive) — loops this same
   * archive() over every document under the case, same shape as CaseSvc.delete looping delete()
   * below. Skips documents already ARCHIVED so archiving a case (or one with documents a user
   * already archived by hand) doesn't write redundant audit rows. */
  static async archiveByCase(caseId: string, organizationId: string, actorId: string) {
    const docs = await DocumentRepo.listAllByCase(caseId);
    for (const doc of docs) {
      if (doc.status === "ACTIVE") await this.archive(doc.id, organizationId, actorId);
    }
  }

  /** Cascades a Case's own restore into its documents (see CaseSvc.unarchive) — mirrors
   * archiveByCase above, in reverse, so restoring a case doesn't leave it "active" with documents
   * that are still hidden in the Archived view. Only restores documents this same case-archive
   * cascade would have archived; one a user deliberately archived by hand while the case was
   * already active would, in practice, already be ACTIVE by the time the case gets archived, so
   * this can't distinguish the two today — same limitation archiveByCase already accepts. */
  static async unarchiveByCase(caseId: string, organizationId: string, actorId: string) {
    const docs = await DocumentRepo.listAllByCase(caseId);
    for (const doc of docs) {
      if (doc.status === "ARCHIVED") await this.unarchive(doc.id, organizationId, actorId);
    }
  }

  /** userId is the authenticated deleter — needed only to attribute an auto-triggered
   * post-extraction refresh (case-post-extraction.ts) to a real actor when a READY, case-scoped
   * document is removed, same as the uploader is used when extraction finishes. */
  static async delete(id: string, organizationId: string, userId: string) {
    const doc = await DocumentRepo.findById(id, organizationId);
    if (!doc) throw new HttpError("Document not found", 404);

    const deleted = await DocumentRepo.delete(id, organizationId);
    if (!deleted) throw new HttpError("Document not found", 404);

    // The Document row (and its RAG chunks, via cascade) are gone now, but its File row and the
    // S3 object it points at are not touched by DocumentRepo.delete — mark the File FOR_DELETION
    // so a cleanup sweep can find and remove it later instead of it staying orphaned forever.
    if (doc.fileId) await FilesRepo.markForDeletionIfOrphaned(doc.fileId);

    if (doc.caseId) await CaseTimelineRepo.detachDocument(id);

    // Only a READY document actually changes the case's READY corpus — deleting a
    // PENDING/FAILED one has nothing for the fingerprint check to see change.
    if (doc.caseId && doc.ragStatus === "READY") {
      const { scheduleCasePostExtraction } = await import("../queues/case-post-extraction");
      scheduleCasePostExtraction(doc.caseId, userId);
    }
  }
}
