import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import GmailConnectionSvc from "../services/gmail-connection.service";
import GmailMailboxSvc from "../services/gmail-mailbox.service";
import HttpError from "../utils/http-error";
import {
  connectGmailSchema,
  gmailAttachmentParamsSchema,
  gmailMessageParamsSchema,
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

  static async disconnect(req: Request, res: Response) {
    res.status(200).json(await GmailConnectionSvc.disconnect(req.user.userId));
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
}
