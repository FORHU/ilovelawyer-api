import CaseRepo, { CaseData } from "../repositories/case.repository";
import HttpError from "../utils/http-error";
import FileSvc from "./files.service";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import prisma from "../lib/prisma";
import { s3UrlForKey } from "../utils/s3";
import { DOCUMENT_CONFIRM_TX_TIMEOUT_MS } from "../constants/document-upload.constants";

export interface IncomingCaseDocument {
  filename: string;
  s3Key: string;
  metaData: {
    documentType?: string;
    fileSize: number;
    mimeType: string;
  };
}

interface CaseWithParties {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  notes?: string | null;
  parties?: { name: string; designation: string }[];
}

export default class CaseSvc {
  static async create(organizationId: string, userId: string, data: CaseData & { caseName: string }) {
    return CaseRepo.create(organizationId, userId, data);
  }

  static async list(organizationId: string, page: number, limit: number, search?: string) {
    return CaseRepo.list(organizationId, page, limit, search);
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

  static async delete(id: string, organizationId: string) {
    const deleted = await CaseRepo.delete(id, organizationId);
    if (!deleted) throw new HttpError("Case not found", 404);
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
      }));

      return DocumentRepo.createManyAndReturn(userDocumentData, tx);
    }, { timeout: DOCUMENT_CONFIRM_TX_TIMEOUT_MS });

    // Enqueued after the transaction commits — rows must exist before a worker reads them.
    // Extraction runs through DocumentExtractionQueue (concurrency 3), not 1:1 with confirm size.
    DocumentExtractionQueue.enqueueMany(createdDocuments.map((doc) => doc.id));

    return createdDocuments;
  }
}
