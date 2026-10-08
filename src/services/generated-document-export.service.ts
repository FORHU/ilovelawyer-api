import { randomUUID } from "crypto";
import FilesRepo from "../repositories/files.repository";
import { renderGeneratedDocx, renderGeneratedPdf } from "../utils/generated-document-renderer";
import { uploadToS3, getProxyFileUrl } from "../utils/s3";
import SecurityAuditSvc from "./security-audit.service";

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
    // Called by chat-wonder with the service API key, so there is no user here; the person who
    // downloads it shows up as file.accessed when they open the link.
    await SecurityAuditSvc.record({
      action: "export.generated_document",
      actorId: null,
      organizationId: null,
      targetType: "file",
      targetId: file.id,
      payload: { format, via: "api_key" },
    });

    return {
      file: { id: file.id, fileUrl: getProxyFileUrl(key, { filename, audit: { kind: "generated_document", id: file.id } }), filename },
    };
  }
}
