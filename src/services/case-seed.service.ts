import crypto from "crypto";
import path from "path";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import DocumentRepo from "../repositories/document.repository";
import FilesRepo from "../repositories/files.repository";
import CaseCopySvc from "./case-copy.service";
import HttpError from "../utils/http-error";
import { caseScope } from "../utils/workspace";
import { s3UrlForKey } from "../utils/s3";
import logger from "../utils/logger";

type SeedRequest = { sourceCaseId: string; lawyerId: string; organizationId: string | null };

/** One document successfully duplicated in S3, ready to be written as a new File + Document. */
type PreparedDocument = {
  fileId: string;
  filename: string | null;
  metaData: Prisma.InputJsonValue | typeof Prisma.DbNull;
  s3Key: string;
  fileUrl: string | null;
  name: string;
  documentType: string | null;
  fileSize: number | null;
  mimeType: string | null;
};

/**
 * Builds a brand-new, lawyer-owned `Case` from a client's case (ilovelawyer-client-invites#own-lawyer):
 * the client invites a lawyer in directly, rather than through the marketplace's ClientRequest flow,
 * and this is what turns their intake into a case the lawyer can actually work from. Called when the
 * invite is redeemed (Task 7), and later reused to seed the marketplace engagement flow's case too
 * (Task 10) — both just need a lawyer-owned Case descended from the client's, so this takes no
 * opinion on why it's being called.
 *
 * Copies the case's summary fields (same ones the client's own "Download case summary" reads —
 * ClientCaseSummarySvc.exportPdf) and a fresh copy of every ACTIVE document, each re-uploaded in S3
 * under the new case so the two cases' files are fully independent from the moment this returns. Not
 * copied: parties, timeline, consultations, AI analysis — this is a seed, not a full portfolio copy
 * (that's CaseCopySvc.copy, which this reuses only its S3-duplication primitive from).
 *
 * A document whose copy fails (the source object is gone, S3 is down, whatever) is skipped rather
 * than failing the whole case — same rule as the client's own zip export (DataExportSvc.streamZip):
 * one bad file never costs the rest of the case.
 */
export default class CaseSeedSvc {
  static async seed({ sourceCaseId, lawyerId, organizationId }: SeedRequest): Promise<{ caseId: string }> {
    const source = await prisma.case.findUnique({ where: { id: sourceCaseId } });
    if (!source) throw new HttpError("Case not found", 404);

    const sourceDocuments = await DocumentRepo.listByCase(caseScope(source), sourceCaseId, "ACTIVE");

    const caseId = crypto.randomUUID();

    // S3 copies happen outside the transaction (network calls) — same reasoning as
    // CaseCopySvc.prepare. A failed copy is skipped here, before anything is written.
    const prepared: PreparedDocument[] = [];
    for (const doc of sourceDocuments) {
      const file = doc.file;
      if (!file?.s3Key) continue;
      const fileId = crypto.randomUUID();
      const destinationKey = `documents/cases/${caseId}/${Date.now()}-${fileId.slice(0, 8)}${path.extname(file.s3Key)}`;
      try {
        await CaseCopySvc.copyObject(file.s3Key, destinationKey);
      } catch (err) {
        logger.warn("CaseSeedSvc: document copy failed, skipping", { err, sourceCaseId, documentId: doc.id });
        continue;
      }
      prepared.push({
        fileId,
        filename: file.filename,
        metaData: file.metaData === null ? Prisma.DbNull : (file.metaData as Prisma.InputJsonValue),
        s3Key: destinationKey,
        fileUrl: s3UrlForKey(destinationKey),
        name: doc.name,
        documentType: doc.documentType,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.case.create({
        data: {
          id: caseId,
          userId: lawyerId,
          organizationId,
          caseName: source.caseName,
          jurisdiction: source.jurisdiction,
          ukJurisdiction: source.ukJurisdiction,
          outsideUk: source.outsideUk,
          caseAreas: source.caseAreas,
          notes: source.notes,
          copiedFromCaseId: source.id,
          copiedAt: new Date(),
        },
      });

      for (const doc of prepared) {
        await tx.file.create({
          data: {
            id: doc.fileId,
            filename: doc.filename,
            fileUrl: doc.fileUrl,
            s3Key: doc.s3Key,
            metaData: doc.metaData,
          },
        });
        await tx.document.create({
          data: {
            userId: lawyerId,
            organizationId,
            caseId,
            fileId: doc.fileId,
            name: doc.name,
            documentType: doc.documentType,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
          },
        });
      }
    });

    return { caseId };
  }

  /**
   * Best-effort removal of a Case that `seed` finished seeding but that its caller then decided
   * not to keep (lost a race to attach it to anything — a lock-loss in `CaseLawyerInviteSvc.redeem`
   * or in the marketplace path's own `seedLawyerCase`, Task 10) — so no ClientRequest ever ends up
   * pointing at it. Deletes the seeded Case's Document rows directly (cheaper than
   * DocumentSvc.delete's per-document audit-log path, which also assumes a real actor/workspace
   * context this cleanup doesn't have), marks each Document's File FOR_DELETION once orphaned (the
   * existing sweep-job convention — see FilesRepo.markForDeletionIfOrphaned and DocumentSvc.delete,
   * which does the same), then deletes the Case row itself. Never throws: a failure here must not
   * mask or replace whatever real error or outcome the caller is already returning, so it's only
   * ever logged.
   */
  static async discard(caseId: string): Promise<void> {
    try {
      const docs = await prisma.document.findMany({ where: { caseId }, select: { id: true, fileId: true } });
      await prisma.document.deleteMany({ where: { caseId } });
      for (const doc of docs) {
        if (doc.fileId) await FilesRepo.markForDeletionIfOrphaned(doc.fileId);
      }
      await prisma.case.delete({ where: { id: caseId } });
    } catch (err) {
      logger.error("CaseSeedSvc.discard: failed to clean up an orphaned seeded case", { err, caseId });
    }
  }
}
