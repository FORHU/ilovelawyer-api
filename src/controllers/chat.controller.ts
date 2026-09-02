import { Request, Response } from "express";
import Joi from "joi";
import ChatSvc from "../services/chat.service";
import DocumentChunkSvc from "../services/document-chunk.service";
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

    const consultations = await ChatSvc.listConsultations(req.organization!.id, value.caseId);
    return res.status(200).json(consultations);
  }

  static async createConsultation(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().optional(),
      caseId: Joi.string().guid().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const consultation = await ChatSvc.createConsultation(req.organization!.id, req.user.userId, value.title, value.caseId);
    return res.status(201).json(consultation);
  }

  static async renameConsultation(req: Request, res: Response) {
    const schema = Joi.object({ title: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const consultation = await ChatSvc.renameConsultation(req.organization!.id, req.params.consultationId, value.title);
    return res.status(200).json(consultation);
  }

  static async deleteConsultation(req: Request, res: Response) {
    await ChatSvc.deleteConsultation(req.organization!.id, req.params.consultationId);
    return res.status(204).send();
  }

  static async listMessages(req: Request, res: Response) {
    const { consultationId } = req.params;
    const messages = await ChatSvc.listMessages(req.organization!.id, consultationId);
    return res.status(200).json(messages);
  }

  static async listReasoning(req: Request, res: Response) {
    const schema = Joi.object({
      consultationId: Joi.string().guid(),
      caseId: Joi.string().guid(),
    }).xor("consultationId", "caseId");
    const { error, value } = schema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const reasoning = await ChatSvc.listReasoning(req.organization!.id, value.consultationId, value.caseId);
    return res.status(200).json(reasoning);
  }

  static async getRelatedCases(req: Request, res: Response) {
    const { consultationId } = req.params;
    const relatedCases = await ChatSvc.getRelatedCases(req.organization!.id, consultationId);
    return res.status(200).json({ relatedCases });
  }

  /** Rank READY consultation-document chunks for a query — payload for chat-wonder grounding. */
  static async relevantChunks(req: Request, res: Response) {
    const schema = Joi.object({
      query: Joi.string().trim().min(1).required(),
      limit: Joi.number().integer().min(1).max(100).default(20),
    });

    const { error, value } = schema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    // Ownership check — throws 404 if missing / not owned.
    await ChatSvc.assertConsultationOwned(req.organization!.id, req.params.consultationId);

    const result = await DocumentChunkSvc.relevantChunksForConsultation(
      req.params.consultationId,
      value.query,
      value.limit,
    );
    return res.status(200).json(result);
  }

  static async deleteMessage(req: Request, res: Response) {
    await ChatSvc.deleteMessage(req.organization!.id, req.params.consultationId, req.params.messageId);
    return res.status(204).send();
  }

  static async generateAudioOverviewAudio(req: Request, res: Response) {
    const result = await ChatSvc.startAudioOverviewAudio(
      req.organization!.id,
      req.params.consultationId,
      req.params.messageId,
    );
    return res.status(200).json(result);
  }

  static async pollAudioOverviewAudio(req: Request, res: Response) {
    const result = await ChatSvc.pollAudioOverviewAudio(
      req.organization!.id,
      req.params.consultationId,
      req.params.messageId,
    );
    return res.status(200).json(result);
  }

  static async sendMessage(req: Request, res: Response) {
    const { consultationId } = req.params;
    const { message, sessionId, documentContext, caseDocumentId, caseId, documentIds } = req.body;

    const schema = Joi.object({
      message: Joi.string().allow("").required(),
      sessionId: Joi.string().required(),
      documentContext: Joi.string().optional(),
      caseDocumentId: Joi.string().optional(),
      caseId: Joi.string().guid().optional(),
      documentIds: Joi.array().items(Joi.string()).optional(),
    }).custom((value, helpers) => {
      // A file-only send (no typed text) is only valid when it's carrying at least one
      // attachment — otherwise there's nothing for the AI to respond to.
      if (!value.message.trim() && !value.documentIds?.length) {
        return helpers.message({ custom: '"message" must not be empty unless "documentIds" is provided' });
      }
      return value;
    });

    const { error } = schema.validate({ message, sessionId, documentContext, caseDocumentId, caseId, documentIds });
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
      req.organization!.id,
      req.organization!.tenantCode,
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
      caseId,
      documentIds,
    );

    res.end();
  }
}
