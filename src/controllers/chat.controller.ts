import { Request, Response } from "express";
import Joi from "joi";
import ChatSvc from "../services/chat.service";
import { getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";

export default class ChatCtrl {
  static async getSession(_req: Request, res: Response) {
    const sessionId = await getChatWonderSessionId();
    return res.status(200).json({ session_id: sessionId });
  }

  static async listConsultations(req: Request, res: Response) {
    const schema = Joi.object({ caseId: Joi.string().guid().optional() });
    const { error, value } = schema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const consultations = await ChatSvc.listConsultations(req.user.userId, value.caseId);
    return res.status(200).json(consultations);
  }

  static async createConsultation(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().optional(),
      caseId: Joi.string().guid().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const consultation = await ChatSvc.createConsultation(req.user.userId, value.title, value.caseId);
    return res.status(201).json(consultation);
  }

  static async renameConsultation(req: Request, res: Response) {
    const schema = Joi.object({ title: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const consultation = await ChatSvc.renameConsultation(req.user.userId, req.params.consultationId, value.title);
    return res.status(200).json(consultation);
  }

  static async deleteConsultation(req: Request, res: Response) {
    await ChatSvc.deleteConsultation(req.user.userId, req.params.consultationId);
    return res.status(204).send();
  }

  static async listMessages(req: Request, res: Response) {
    const { consultationId } = req.params;
    const messages = await ChatSvc.listMessages(req.user.userId, consultationId);
    return res.status(200).json(messages);
  }

  static async getRelatedCases(req: Request, res: Response) {
    const { consultationId } = req.params;
    const relatedCases = await ChatSvc.getRelatedCases(req.user.userId, consultationId);
    return res.status(200).json({ relatedCases });
  }

  static async deleteMessage(req: Request, res: Response) {
    await ChatSvc.deleteMessage(req.user.userId, req.params.consultationId, req.params.messageId);
    return res.status(204).send();
  }

  static async sendMessage(req: Request, res: Response) {
    const { consultationId } = req.params;
    const { message, sessionId, documentContext, caseDocumentId } = req.body;

    const schema = Joi.object({
      message: Joi.string().required(),
      sessionId: Joi.string().required(),
      documentContext: Joi.string().optional(),
      caseDocumentId: Joi.string().optional(),
    });

    const { error } = schema.validate({ message, sessionId, documentContext, caseDocumentId });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    let effectiveSessionId = sessionId;
    let headersSent = false;
    const writeChunk = (chunk: string) => {
      if (!headersSent) {
        headersSent = true;
        const headers: Record<string, string> = {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Transfer-Encoding": "chunked",
          // Tells an nginx reverse proxy (if one sits in front of this API) not to
          // buffer the response before forwarding it — otherwise chunked streaming
          // arrives at the client all at once instead of incrementally.
          "X-Accel-Buffering": "no",
        };
        // Chat Wonder's session_id is cached client-side indefinitely; if this request
        // had to rotate to a fresh one (see ChatSvc.streamWithSessionRetry), tell the
        // client so it can update its cache instead of repeating the same failed-then-
        // retried round trip on every future message.
        if (effectiveSessionId !== sessionId) {
          headers["X-Chat-Session-Id"] = effectiveSessionId;
        }
        res.writeHead(200, headers);
      }
      res.write(chunk);
    };

    await ChatSvc.sendMessage(
      req.user.userId,
      consultationId,
      sessionId,
      message,
      writeChunk,
      documentContext,
      (newSessionId) => {
        effectiveSessionId = newSessionId;
      },
      caseDocumentId,
    );

    res.end();
  }
}
