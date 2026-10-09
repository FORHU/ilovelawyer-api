import CaseRepo, { CaseData } from "../repositories/case.repository";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import CaseAccess from "../utils/case-access";
import FileSvc from "./files.service";
import DocumentSvc from "./document.service";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import prisma from "../lib/prisma";
import { s3UrlForKey } from "../utils/s3";
import { DOCUMENT_CONFIRM_TX_TIMEOUT_MS } from "../constants";
import { IncomingCaseDocument, CaseWithParties } from "../types/case.types";
import { CaseStatus } from "@prisma/client";
import SecurityAuditSvc from "./security-audit.service";

export default class CaseSvc {
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    return CaseRepo.create(organizationId, userId, data);
  }

  static async list(
    organizationId: string,
    userId: string,
    page: number,
    limit: number,
    search?: string,
    status?: CaseStatus,
    createdBy?: string,
  ) {
    const result = await CaseRepo.list(organizationId, userId, page, limit, search, status, createdBy);
    return { ...result, data: await CaseRepo.withCopyContext(result.data, userId) };
  }

  /** "Last opened" for the requesting user. Org-scoped existence check first so a caseId from
   * another organization can't be stamped, and one they can't open (#346) isn't either. */
  static async markOpened(id: string, organizationId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(id, userId);
    const caseRecord = await CaseRepo.findById(id, organizationId);
    if (!caseRecord) throw new HttpError("Case not found", 404);
    await CaseRepo.markOpened(id, userId);
  }

  /** The case, for a user who can open it (CaseAccess — a confidential case 404s for anyone walled
   * off from it, #346) in this organization. A portfolio copy also says how it relates to its
   * original (see CaseRepo.withCopyContext) — what the case page shows. */
  static async getById(id: string, organizationId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(id, userId);
    const caseRecord = await CaseRepo.findById(id, organizationId);
    if (!caseRecord) throw new HttpError("Case not found", 404);
    const [withContext] = await CaseRepo.withCopyContext([caseRecord], userId);
    return withContext;
  }

  /** update/delete/archive/unarchive (and their bulk forms, which loop these) take the same bar
   * as editing anything inside the case — CaseAccess.assertCanEdit: org OWNER/ADMIN, or an
   * explicit EDIT/ADMIN grant. Before #345 they scoped by organizationId alone, so a plain
   * member could delete a whole case while unable to edit one finding in it. The
   * organizationId scoping below still applies on top: a grant on a case in another
   * organization doesn't reach it through this one. */
  static async update(id: string, organizationId: string, actorId: string, data: CaseData) {
    await CaseAccess.assertCanEdit(id, actorId);
    const before = data.clientSide !== undefined ? await CaseRepo.findById(id, organizationId) : null;
    const updated = await CaseRepo.update(id, organizationId, data);
    if (!updated) throw new HttpError("Case not found", 404);
    // The findings were written for the other side — the next Terminal load regenerates them
    // (CaseFindingAiSvc.scheduleIfOutdated).
    if (before && before.clientSide !== data.clientSide) await CaseRepo.clearFindingsFormatVersion(id);
    return CaseRepo.findById(id, organizationId);
  }

  /** Document.caseId's FK is ON DELETE SET NULL, not CASCADE (see schema) — nothing removes a
   * case's documents automatically when the Case row goes, so each is deleted explicitly first,
   * through the same path DocumentSvc.delete's single-document endpoint uses (drops its RAG
   * chunks via cascade, marks its File FOR_DELETION for the cleanup sweep). Existence/ownership
   * is checked up front so a caseId from another organization can't reach listAllByCase at all;
   * listAllByCase itself is also scoped to the case's own organization (#373), so a document
   * mis-attached to this case from elsewhere is left out of the cascade rather than failing it. */
  static async delete(id: string, organizationId: string, actorId: string) {
    await CaseAccess.assertCanEdit(id, actorId);
    const caseRecord = await CaseRepo.findById(id, organizationId);
    if (!caseRecord) throw new HttpError("Case not found", 404);

    const docs = await DocumentRepo.listAllByCase(id);
    for (const doc of docs) {
      await DocumentSvc.delete(doc.id, organizationId, actorId);
    }

    await CaseRepo.delete(id, organizationId);
    await SecurityAuditSvc.record({
      action: "case.deleted",
      actorId,
      organizationId,
      targetType: "case",
      targetId: id,
      targetName: caseRecord.caseName,
      caseId: id,
      payload: { documentsDeleted: docs.length },
    });
  }

  /** Bulk delete from the case list — loops delete() (document cleanup included) over every
   * selected id with allSettled so one missing case doesn't fail the rest of the batch. Mirrors
   * archiveMany below; `succeeded` is the deleted ids, since there's no row left to return. */
  static async deleteMany(ids: string[], organizationId: string, actorId: string) {
    const results = await Promise.allSettled(ids.map((id) => this.delete(id, organizationId, actorId)));
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") succeeded.push(ids[i]);
      else failed.push({ id: ids[i], error: result.reason instanceof Error ? result.reason.message : "Failed to delete case" });
    });
    return { succeeded, failed };
  }

  /** Archiving/unarchiving are independent of delete — an archived case can still be deleted,
   * and archiving never blocks anything else on the case (documents, chat, auto-refresh all
   * keep working identically). Gated like update/delete above. */
  static async archive(id: string, organizationId: string, actorId: string) {
    await CaseAccess.assertCanEdit(id, actorId);
    const updated = await CaseRepo.setStatus(id, organizationId, "ARCHIVED");
    if (!updated) throw new HttpError("Case not found", 404);
    await OrganizationRepo.writeAudit({ caseId: id, actorId, action: "case.archive" });
    // Cascades into the case's own documents — see DocumentSvc.archiveByCase.
    await DocumentSvc.archiveByCase(id, organizationId, actorId);
    return updated;
  }

  /** Bulk "Select All" archive from the Active Cases tab — loops archive() (cascade included)
   * over every selected id with allSettled so one missing/already-archived case doesn't fail the
   * rest of the batch. Mirrors unarchiveMany below. */
  static async archiveMany(ids: string[], organizationId: string, actorId: string) {
    const results = await Promise.allSettled(ids.map((id) => this.archive(id, organizationId, actorId)));
    const succeeded: Awaited<ReturnType<typeof CaseRepo.setStatus>>[] = [];
    const failed: { id: string; error: string }[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") succeeded.push(result.value);
      else failed.push({ id: ids[i], error: result.reason instanceof Error ? result.reason.message : "Failed to archive case" });
    });
    return { succeeded, failed };
  }

  static async unarchive(id: string, organizationId: string, actorId: string) {
    await CaseAccess.assertCanEdit(id, actorId);
    const updated = await CaseRepo.setStatus(id, organizationId, "ACTIVE");
    if (!updated) throw new HttpError("Case not found", 404);
    await OrganizationRepo.writeAudit({ caseId: id, actorId, action: "case.unarchive" });
    // Cascades into the case's own documents, mirroring archive()'s cascade above — otherwise a
    // restored case would show back up as Active while its documents stayed stuck in Archived.
    await DocumentSvc.unarchiveByCase(id, organizationId, actorId);
    return updated;
  }

  /** Bulk "Select All" restore from the Archived Cases tab — loops unarchive() (cascade included)
   * over every selected id with allSettled so one missing/already-active case doesn't fail the
   * rest of the batch. */
  static async unarchiveMany(ids: string[], organizationId: string, actorId: string) {
    const results = await Promise.allSettled(ids.map((id) => this.unarchive(id, organizationId, actorId)));
    const succeeded: Awaited<ReturnType<typeof CaseRepo.setStatus>>[] = [];
    const failed: { id: string; error: string }[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") succeeded.push(result.value);
      else failed.push({ id: ids[i], error: result.reason instanceof Error ? result.reason.message : "Failed to restore case" });
    });
    return { succeeded, failed };
  }

  /**
   * Formats a Case's structured fields as plain text so the AI has the case's
   * details without the user re-explaining them each message. Re-run per message
   * (not cached) so edits to the Case are reflected immediately, never stale.
   */
  static formatForAiContext(caseRecord: CaseWithParties): string {
    const lines: string[] = [`Case: ${caseRecord.caseName}`];

    if (caseRecord.actionType) lines.push(`Type of Action: ${caseRecord.actionType}`);
    if (caseRecord.jurisdiction) lines.push(`Jurisdiction: ${caseRecord.jurisdiction}`);
    if (caseRecord.ukJurisdiction) lines.push(`UK Jurisdiction: ${caseRecord.ukJurisdiction}`);

    if (caseRecord.parties && caseRecord.parties.length > 0) {
      lines.push("Parties:");
      for (const party of caseRecord.parties) {
        lines.push(`- ${party.name} (${party.designation})`);
      }
    }

    if (caseRecord.notes) lines.push(`Notes: ${caseRecord.notes}`);

    return lines.join("\n");
  }

  static async handleCreateCaseWithDocument(
    caseData: { caseId: string; organizationId: string; userId: string },
    documentData: IncomingCaseDocument[],
  ) {
    // In this organization and a case the uploader can open — not a confidential one walled off
    // from them (#346).
    await this.getById(caseData.caseId, caseData.organizationId, caseData.userId);

    // fileUrl is derived from s3Key server-side, never accepted from the client (spoofing risk:
    // a client-supplied fileUrl could point a row at an S3 object it doesn't own).
    const filesToCreate: Express.FileTypes[] = documentData.map((doc) => ({
      filename: doc.filename,
      fileUrl: s3UrlForKey(doc.s3Key),
      s3Key: doc.s3Key,
      metaData: doc.metaData,
    }));

    const createdDocuments = await prisma.$transaction(async (tx) => {
      const files = await FileSvc.createFile(filesToCreate, tx);

      const userDocumentData = files.map((file, i) => ({
        organizationId: caseData.organizationId,
        userId: caseData.userId,
        caseId: caseData.caseId,
        name: file.filename ?? "",
        fileId: file.id,
        documentType: documentData[i].metaData.documentType,
        fileSize: documentData[i].metaData.fileSize,
        mimeType: documentData[i].metaData.mimeType,
        category: documentData[i].metaData.category,
      }));

      return DocumentRepo.createManyAndReturn(userDocumentData, tx);
    }, { timeout: DOCUMENT_CONFIRM_TX_TIMEOUT_MS });

    // Enqueued after the transaction commits — rows must exist before a worker reads them.
    // Extraction runs through DocumentExtractionQueue (concurrency 3), not 1:1 with confirm size.
    DocumentExtractionQueue.enqueueMany(createdDocuments.map((doc) => doc.id));

    return createdDocuments;
  }
}
