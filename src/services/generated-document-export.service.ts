import { randomUUID } from "crypto";
import FilesRepo from "../repositories/files.repository";
import type { BriefBlock, BriefDocument } from "../utils/case-brief-document";
import { renderBriefToDocx } from "../utils/case-brief-docx-renderer";
import { renderBriefToPdf } from "../utils/case-brief-pdf-renderer";
import { uploadToS3, getPresignedGetUrl } from "../utils/s3";

export type GeneratedDocumentFormat = "docx" | "pdf";

const CONTENT_TYPES: Record<GeneratedDocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

/** Filesystem/URL-safe slug for the download filename — same local helper as
 * CaseBriefExportSvc (no shared sanitize helper in src/utils to reuse — confirmed there too,
 * not re-checked and skipped here). */
function sanitizeFilename(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

/** Splits chat-wonder's drafted text into BriefBlock[] — deliberately small: blank-line-separated
 * paragraphs, promoted to heading1/heading2 only on literal markdown `# `/`## ` syntax. In
 * practice draft_pleading/generate_legal_document output isn't markdown-header-structured (no
 * `#`/`##` at all — confirmed against #72's live test output), so most content lands as plain
 * paragraphs; that's correct, not a gap — the whole document already gets one section titled
 * `documentName` in export() below, so losing sub-heading structure doesn't lose the document. */
function toBriefBlocks(content: string): BriefBlock[] {
  return content
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): BriefBlock => {
      if (chunk.startsWith("## ")) return { type: "heading2", text: chunk.slice(3).trim() };
      if (chunk.startsWith("# ")) return { type: "heading1", text: chunk.slice(2).trim() };
      return { type: "paragraph", text: chunk };
    });
}

export default class GeneratedDocumentExportSvc {
  /** Wraps plain drafted text (chat-wonder's draft_pleading/generate_legal_document output) into
   * a downloadable docx/pdf — same rendering pipeline as CaseBriefExportSvc, built from raw text
   * instead of a case snapshot. No case access check here: this isn't case-scoped, it's a
   * standalone document handed to us already-drafted; the caller (route/controller) is
   * responsible for whatever auth applies to the chat-wonder request itself. */
  static async export(content: string, documentName: string, format: GeneratedDocumentFormat) {
    const briefDoc: BriefDocument = {
      cover: {
        caseName: documentName,
        actionType: null,
        jurisdiction: null,
        generatedAt: new Date(),
        lastRefreshedAt: null,
      },
      sections: [{ title: documentName, blocks: toBriefBlocks(content) }],
    };

    const buffer = format === "pdf" ? await renderBriefToPdf(briefDoc) : await renderBriefToDocx(briefDoc);

    const key = `generated-documents/${randomUUID()}.${format}`;
    const outputUri = await uploadToS3(key, buffer, CONTENT_TYPES[format]);
    const filename = `${sanitizeFilename(documentName)}.${format}`;
    const file = await FilesRepo.create(filename, outputUri, key, { source: "chat-wonder", documentName });

    return { file: { id: file.id, fileUrl: await getPresignedGetUrl(key), filename } };
  }
}
