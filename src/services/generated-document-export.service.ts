import { randomUUID } from "crypto";
import FilesRepo from "../repositories/files.repository";
import { renderGeneratedDocx, renderGeneratedPdf } from "../utils/generated-document-renderer";
import { uploadToS3, getPresignedGetUrl } from "../utils/s3";

export type GeneratedDocumentFormat = "docx" | "pdf";

const CONTENT_TYPES: Record<GeneratedDocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

/** Filesystem/URL-safe slug for the download filename. */
function sanitizeFilename(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

export default class GeneratedDocumentExportSvc {
  /** Renders plain drafted text (chat-wonder's draft_pleading/generate_legal_document output) into
   * a downloadable docx/pdf and stores it. Unlike CaseBriefExportSvc this outputs just the drafted
   * text — no case-brief cover page or table of contents (see generated-document-renderer.ts). No
   * case access check here: this isn't case-scoped, it's a standalone document handed to us
   * already-drafted; the caller is responsible for whatever auth applies to the chat-wonder
   * request itself. */
  static async export(content: string, documentName: string, format: GeneratedDocumentFormat) {
    const buffer = format === "pdf" ? await renderGeneratedPdf(content) : await renderGeneratedDocx(content);

    const key = `generated-documents/${randomUUID()}.${format}`;
    const outputUri = await uploadToS3(key, buffer, CONTENT_TYPES[format]);
    const filename = `${sanitizeFilename(documentName)}.${format}`;
    const file = await FilesRepo.create(filename, outputUri, key, { source: "chat-wonder", documentName });

    return { file: { id: file.id, fileUrl: await getPresignedGetUrl(key), filename } };
  }
}
