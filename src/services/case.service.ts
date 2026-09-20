import CaseRepo, { CaseData } from "../repositories/case.repository";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import FileSvc from "./files.service";
import DocumentSvc from "./document.service";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import prisma from "../lib/prisma";
import { s3UrlForKey } from "../utils/s3";
import { DOCUMENT_CONFIRM_TX_TIMEOUT_MS } from "../constants";
import { IncomingCaseDocument, CaseWithParties } from "../types/case.types";
import { CaseStatus } from "@prisma/client";

export default class CaseSvc {
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    return CaseRepo.create(organizationId, userId, data);
  }

  static async list(organizationId: string, page: number, limit: number, search?: string, status?: CaseStatus) {
    return CaseRepo.list(organizationId, page, limit, search, status);
  }

  static async getById(id: string, organizationId: string) {
    const caseRecord = await CaseRepo.findById(id, organizationId);
    if (!caseRecord) throw new HttpError("Case not found", 404);
    return caseRecord;
  }

  static async update(id: string, organizationId: string, data: CaseData) {
    const updated = await CaseRepo.update(id, organizationId, data);
    if (!updated) throw new HttpError("Case not found", 404);
    return CaseRepo.findById(id, organizationId);
  }

  /** Document.caseId's FK is ON DELETE SET NULL, not CASCADE (see schema) — nothing removes a
   * case's documents automatically when the Case row goes, so each is deleted explicitly first,
   * through the same path DocumentSvc.delete's single-document endpoint uses (drops its RAG
   * chunks via cascade, marks its File FOR_DELETION for the cleanup sweep). Existence/ownership
   * is checked up front so a caseId from another organization can't reach DocumentRepo's
   * unscoped listAllByCase. */
  static async delete(id: string, organizationId: string, actorId: string) {
    const caseRecord = await CaseRepo.findById(id, organizationId);
    if (!caseRecord) throw new HttpError("Case not found", 404);

    const docs = await DocumentRepo.listAllByCase(id);
    for (const doc of docs) {
      await DocumentSvc.delete(doc.id, organizationId, actorId);
    }

    await CaseRepo.delete(id, organizationId);
  }

  /** Archiving/unarchiving are independent of delete — an archived case can still be deleted,
   * and archiving never blocks anything else on the case (documents, chat, auto-refresh all
   * keep working identically). No CaseAccess check here, matching update/delete above — this
   * service scopes purely by organizationId, unlike the CaseAccess-gated case sub-resources. */
  static async archive(id: string, organizationId: string, actorId: string) {
    const updated = await CaseRepo.setStatus(id, organizationId, "ARCHIVED");
    if (!updated) throw new HttpError("Case not found", 404);
    await OrganizationRepo.writeAudit({ caseId: id, actorId, action: "case.archive" });
    // Cascades into the case's own documents — see DocumentSvc.archiveByCase.
    await DocumentSvc.archiveByCase(id, organizationId, actorId);
    return updated;
  }

  static async unarchive(id: string, organizationId: string, actorId: string) {
    const updated = await CaseRepo.setStatus(id, organizationId, "ACTIVE");
    if (!updated) throw new HttpError("Case not found", 404);
    await OrganizationRepo.writeAudit({ caseId: id, actorId, action: "case.unarchive" });
    return updated;
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
    await this.getById(caseData.caseId, caseData.organizationId);

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
