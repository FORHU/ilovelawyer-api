import path from "path";
import { randomUUID } from "crypto";
import ClientCaseSvc, { type ClientWorkspace } from "./client-case.service";
import GmailMailboxSvc from "./gmail-mailbox.service";
import SecurityAuditSvc from "./security-audit.service";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { uploadToS3 } from "../utils/s3";
import { emailBodyText, renderEmailPdf } from "../utils/email-pdf-renderer";
import { ALLOWED_DOCUMENT_FILENAME_PATTERN } from "../constants";

export interface GmailCaseImportInput {
  messageId: string;
  /** Add the email itself, as a PDF. */
  includeEmail: boolean;
  /** Attachments to add, each as its own document (partIds from the message view). */
  attachmentPartIds: string[];
}

/** A name that's safe as a document and file name: no path or control characters, no runs of
 * spaces, at most `max` characters before the extension. */
export function safeFileName(name: string, ext: string, max = 120): string {
  const base = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return `${base || "Email"}${ext}`;
}

/** "Email - Deposit dispute - 2026-03-03.pdf" */
export function emailPdfName(subject: string | null, date: string | null): string {
  const day = date && !Number.isNaN(new Date(date).getTime()) ? ` - ${new Date(date).toISOString().slice(0, 10)}` : "";
  return safeFileName(`Email - ${subject?.trim() || "(no subject)"}${day}`, ".pdf");
}

/** Whether a case can take this file as a document: the same types an upload accepts. */
export function isSupportedAttachment(filename: string): boolean {
  return ALLOWED_DOCUMENT_FILENAME_PATTERN.test(filename);
}

/** Same layout as DocumentSvc's presigned keys, so these files sit beside uploaded ones. */
function caseDocumentKey(caseId: string, filename: string): string {
  return `documents/cases/${caseId}/${Date.now()}-${randomUUID().slice(0, 8)}${path.extname(filename).toLowerCase()}`;
}

/**
 * Adds an email from the client's connected Gmail to one of their cases (EPIC #982, #986/#987):
 * the email as a PDF (headers, body and attachment list) and any chosen attachments, each as its
 * own case document. The client picks exactly what's added; nothing else is copied.
 *
 * Everything is read and rendered before anything is saved, so a Gmail error adds nothing. Each
 * file then goes through ClientCaseSvc.addDocument like an upload: extraction runs, the AI can use
 * it once READY, and an engaged lawyer is told.
 */
export default class GmailCaseImportSvc {
  /** Puts a file in S3 (a seam for the specs, which never reach S3). */
  static upload: (key: string, body: Buffer, contentType: string) => Promise<unknown> = uploadToS3;

  static async importToCase(workspace: ClientWorkspace, userId: string, caseId: string, input: GmailCaseImportInput) {
    const partIds = [...new Set(input.attachmentPartIds)];
    if (!input.includeEmail && partIds.length === 0) {
      throw new HttpError("Choose the email or at least one attachment to add.", 400);
    }
    await ClientCaseSvc.load(workspace, caseId);

    const { message, files } = await GmailMailboxSvc.getMessageWithAttachments(userId, input.messageId, partIds);
    const unsupported = files.filter((f) => !isSupportedAttachment(f.filename));
    if (unsupported.length) {
      throw new HttpError(
        `${unsupported.map((f) => f.filename).join(", ")} can't be added to a case: that file type isn't supported.`,
        400,
        "GMAIL_ATTACHMENT_UNSUPPORTED",
        { filenames: unsupported.map((f) => f.filename) },
      );
    }

    const toSave: { name: string; buffer: Buffer; contentType: string }[] = files.map((f) => ({
      name: safeFileName(path.basename(f.filename, path.extname(f.filename)), path.extname(f.filename)),
      buffer: f.buffer,
      contentType: f.mimeType,
    }));
    if (input.includeEmail) {
      const mailbox = (await AuthRepo.findGmailTokens(userId))?.gmailEmail ?? null;
      const added = new Set(partIds);
      const pdf = await renderEmailPdf({
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        dateHeader: message.dateHeader,
        date: message.date,
        messageIdHeader: message.messageIdHeader,
        body: emailBodyText(message.textBody, message.htmlBody),
        attachments: message.attachments.filter((a) => !a.inline).map((a) => ({ filename: a.filename, size: a.size, addedToCase: added.has(a.partId) })),
        mailbox,
        importedAt: new Date(),
      });
      toSave.unshift({ name: emailPdfName(message.subject, message.date), buffer: pdf, contentType: "application/pdf" });
    }

    const documents = [];
    for (const file of toSave) {
      const key = caseDocumentKey(caseId, file.name);
      await GmailCaseImportSvc.upload(key, file.buffer, file.contentType);
      documents.push(
        await ClientCaseSvc.addDocument(workspace, userId, caseId, { key, name: file.name, contentType: file.contentType, fileSize: file.buffer.length }),
      );
    }

    await SecurityAuditSvc.record({
      action: "gmail.imported_to_case",
      actorId: userId,
      targetType: "case",
      targetId: caseId,
      payload: { type: "gmail", messageId: message.id, email: input.includeEmail, attachmentPartIds: partIds, documentIds: documents.map((d) => d.id) },
    });
    return { documents };
  }
}
