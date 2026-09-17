import CaseSnapshotSvc from "./case-snapshot.service";
import CaseAccess from "../utils/case-access";
import FilesRepo from "../repositories/files.repository";
import CaseBriefExportRepo from "../repositories/case-brief-export.repository";
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
   * CaseAccess.loadAccessibleCase internally, so this needs no separate access check.
   * Every call is logged to history (§CaseBriefExportRepo) — preview and download alike, no
   * distinction between the two; a lawyer opening the preview is still "generating a brief" as
   * far as history is concerned (confirmed with the user rather than assumed). */
  static async export(caseId: string, userId: string, format: CaseBriefFormat) {
    const snapshot = await CaseSnapshotSvc.get(caseId, userId);
    const briefDoc = buildBriefDocument(snapshot);
    const buffer = format === "docx" ? await renderBriefToDocx(briefDoc) : await renderBriefToPdf(briefDoc);

    const key = `case-briefs/${caseId}/${Date.now()}.${format}`;
    const outputUri = await uploadToS3(key, buffer, CONTENT_TYPES[format]);
    const filename = `${sanitizeFilename(snapshot.case.caseName)}-case-brief.${format}`;
    const file = await FilesRepo.create(filename, outputUri, key);
    await CaseBriefExportRepo.create(caseId, userId, format, file.id);

    return { file: { id: file.id, fileUrl: await getPresignedGetUrl(key) } };
  }

  /** History listing needs its own access check — unlike export(), it never calls
   * CaseSnapshotSvc.get(), so nothing else here does that check implicitly. Read-level access,
   * matching the snapshot/export endpoints it sits alongside.
   * Cursor-paginated for infinite scroll (not numbered pages) — same nextCursor convention as
   * NotificationSvc.list: present only when a full page came back, since that's the only case
   * where there might be more. */
  static async listHistory(caseId: string, userId: string, filters: { limit?: number; cursor?: string } = {}) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const rows = await CaseBriefExportRepo.listByCase(caseId, filters);
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        format: row.format as CaseBriefFormat,
        createdAt: row.createdAt,
        file: { id: row.file.id, fileUrl: row.file.s3Key ? await getPresignedGetUrl(row.file.s3Key) : row.file.fileUrl },
      })),
    );
    const nextCursor = filters.limit && items.length === filters.limit ? items[items.length - 1]!.id : null;
    return { items, nextCursor };
  }
}
