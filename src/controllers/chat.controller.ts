import { Request, Response } from "express";
import Joi from "joi";
import ChatSvc from "../services/chat.service";
import { getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

export default class ChatCtrl {
  static async getSession(_req: Request, res: Response) {
    const sessionId = await getChatWonderSessionId();
    return res.status(200).json({ session_id: sessionId });
  }

  static async listConversations(req: Request, res: Response) {
    const schema = Joi.object({ caseId: Joi.string().guid().optional() });
    const { error, value } = schema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const conversations = await ChatSvc.listConversations(req.user.userId, value.caseId);
    return res.status(200).json(conversations);
  }

  static async createConversation(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().optional(),
      caseId: Joi.string().guid().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const conversation = await ChatSvc.createConversation(req.user.userId, value.title, value.caseId);
    return res.status(201).json(conversation);
  }

  static async renameConversation(req: Request, res: Response) {
    const schema = Joi.object({ title: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const conversation = await ChatSvc.renameConversation(req.user.userId, req.params.conversationId, value.title);
    return res.status(200).json(conversation);
  }

  static async deleteConversation(req: Request, res: Response) {
    await ChatSvc.deleteConversation(req.user.userId, req.params.conversationId);
    return res.status(204).send();
  }

  static async listMessages(req: Request, res: Response) {
    const { conversationId } = req.params;
    const messages = await ChatSvc.listMessages(req.user.userId, conversationId);
    return res.status(200).json(messages);
  }

  static async getRelatedCases(req: Request, res: Response) {
    const { conversationId } = req.params;
    const relatedCases = await ChatSvc.getRelatedCases(req.user.userId, conversationId);
    return res.status(200).json({ relatedCases });
  }

  static async deleteMessage(req: Request, res: Response) {
    await ChatSvc.deleteMessage(req.user.userId, req.params.conversationId, req.params.messageId);
    return res.status(204).send();
  }

  static async sendMessage(req: Request, res: Response) {
    const { conversationId } = req.params;
    const { message, sessionId } = req.body;

    const schema = Joi.object({
      message: Joi.string().max(20000).required(),
      sessionId: Joi.string().required(),
    });

    const { error } = schema.validate({ message, sessionId });
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

    try {
      await ChatSvc.sendMessage(
        req.user.userId,
        conversationId,
        sessionId,
        message,
        writeChunk,
        (newSessionId) => {
          effectiveSessionId = newSessionId;
        },
      );
    } catch (err) {
      logger.error("chat stream failed mid-response", { err, conversationId });
      if (headersSent) {
        // Streaming already started — the client is mid-chunked-response, so we can't
        // fall back to a JSON error. Append a visible notice and terminate the chunked
        // body cleanly instead of leaving the connection to time out as
        // ERR_INCOMPLETE_CHUNKED_ENCODING.
        writeChunk("\n\n[Error: the response was interrupted. Please try again.]");
        return res.end();
      }
      throw err; // nothing sent yet — let the global error handler produce the normal JSON error
    }

    res.end();
  }
}
