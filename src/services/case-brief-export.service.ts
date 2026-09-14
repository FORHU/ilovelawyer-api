import CaseSnapshotSvc from "./case-snapshot.service";
import FilesRepo from "../repositories/files.repository";
import { buildBriefDocument } from "../utils/case-brief-document";
import { renderBriefToDocx } from "../utils/case-brief-docx-renderer";
import { renderBriefToPdf } from "../utils/case-brief-pdf-renderer";
import { uploadToS3, getPresignedGetUrl } from "../utils/s3";

export type CaseBriefFormat = "docx" | "pdf";

const CONTENT_TYPES: Record<CaseBriefFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

/** Filesystem/URL-safe slug for the download filename — no existing sanitize helper in src/utils
 * to reuse (checked before writing this). */
function sanitizeFilename(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}

export default class CaseBriefExportSvc {
  /** Same case access as the snapshot — CaseSnapshotSvc.get() already calls
   * CaseAccess.loadAccessibleCase internally, so this needs no separate access check. */
  static async export(caseId: string, userId: string, format: CaseBriefFormat) {
    const snapshot = await CaseSnapshotSvc.get(caseId, userId);
    const briefDoc = buildBriefDocument(snapshot);
    const buffer = format === "docx" ? await renderBriefToDocx(briefDoc) : await renderBriefToPdf(briefDoc);

    const key = `case-briefs/${caseId}/${Date.now()}.${format}`;
    const outputUri = await uploadToS3(key, buffer, CONTENT_TYPES[format]);
    const filename = `${sanitizeFilename(snapshot.case.caseName)}-case-brief.${format}`;
    const file = await FilesRepo.create(filename, outputUri, key);

    return { file: { id: file.id, fileUrl: await getPresignedGetUrl(key) } };
  }
}
