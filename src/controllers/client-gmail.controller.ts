import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import GmailConnectionSvc from "../services/gmail-connection.service";
import ConsentSvc from "../services/consent.service";
import GmailMailboxSvc from "../services/gmail-mailbox.service";
import GmailCaseImportSvc from "../services/gmail-case-import.service";
import GmailCaseSuggestSvc from "../services/gmail-case-suggest.service";
import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import HttpError from "../utils/http-error";
import {
  connectGmailSchema,
  gmailAttachmentParamsSchema,
  gmailMessageParamsSchema,
  importGmailToCaseSchema,
  searchGmailSchema,
} from "../validation/client-gmail.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** RFC 6266 filename for a download: an ASCII fallback plus the exact UTF-8 name. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The client app's Gmail connection and read-only inbox access (EPIC #982, #983). Connect and
 * disconnect answer with the updated user, like the Calendar routes, so the app can update its
 * session in one step. */
export default class ClientGmailCtrl {
  static async connect(req: Request, res: Response) {
    const { code } = validate(connectGmailSchema, req.body ?? {});
    res.status(200).json(await GmailConnectionSvc.connect(req.user.userId, code));
  }

  /** Disconnecting also withdraws email-import consent, so connecting again asks for it again. */
  static async disconnect(req: Request, res: Response) {
    const user = await GmailConnectionSvc.disconnect(req.user.userId);
    await ConsentSvc.set(req.user.userId, "EMAIL_IMPORT", false, "gmail");
    res.status(200).json(user);
  }

  static async search(req: Request, res: Response) {
    const query = validate(searchGmailSchema, req.query);
    res.status(200).json(await GmailMailboxSvc.search(req.user.userId, query));
  }

  static async message(req: Request, res: Response) {
    const { messageId } = validate(gmailMessageParamsSchema, req.params);
    res.status(200).json(await GmailMailboxSvc.getMessage(req.user.userId, messageId));
  }

  static async downloadAttachment(req: Request, res: Response) {
    const { messageId, partId } = validate(gmailAttachmentParamsSchema, req.params);
    const { buffer, filename, mimeType } = await GmailMailboxSvc.getAttachment(req.user.userId, messageId, partId);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", contentDisposition(filename));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(buffer);
  }

  /** "Suggest by AI": emails in the client's Gmail that Intake judges relevant to the case. */
  static async suggestForCase(req: Request, res: Response) {
    res.status(200).json(await GmailCaseSuggestSvc.suggest(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  /** Adds an email (as a PDF) and/or chosen attachments to one of the client's cases. */
  static async importToCase(req: Request, res: Response) {
    const input = validate(importGmailToCaseSchema, req.body ?? {});
    res.status(201).json(await GmailCaseImportSvc.importToCase(clientWorkspaceOf(req), req.user.userId, req.params.caseId, input));
  }
}
