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

  static async createConversation(req: Request, res: Response) {
    const { title } = req.body;

    const schema = Joi.object({
      title: Joi.string().optional(),
    });

    const { error } = schema.validate({ title });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const conversation = await ChatSvc.createConversation(req.user.userId, title);

    return res.status(201).json(conversation);
  }

  static async listMessages(req: Request, res: Response) {
    const { conversationId } = req.params;

    const messages = await ChatSvc.listMessages(req.user.userId, conversationId);

    return res.status(200).json(messages);
  }

  static async sendMessage(req: Request, res: Response) {
    const { conversationId } = req.params;
    const { message, sessionId, documentContext } = req.body;

    const schema = Joi.object({
      message: Joi.string().required(),
      sessionId: Joi.string().required(),
      documentContext: Joi.string().optional(),
    });

    const { error } = schema.validate({ message, sessionId, documentContext });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    let headersSent = false;
    const writeChunk = (chunk: string) => {
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Transfer-Encoding": "chunked",
        });
      }
      res.write(chunk);
    };


    await ChatSvc.sendMessage(req.user.userId, conversationId, sessionId, message, writeChunk, documentContext);

    res.end();
  }
}
