import { Request, Response } from "express";
import ChatSvc from "../services/chat.service";
import MindMapSvc from "../services/mind-map.service";
import DocumentChunkSvc from "../services/document-chunk.service";
import { getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import {
  listConsultationsSchema,
  createConsultationSchema,
  renameConsultationSchema,
  relevantChunksSchema,
  sendMessageSchema,
  expandMindMapNodeSchema,
  revertMindMapSchema,
  editMindMapNodeSchema,
} from "../validation/chat.validation";

export default class ChatCtrl {
  static async getSession(_req: Request, res: Response) {
    const sessionId = await getChatWonderSessionId();
    return res.status(200).json({ session_id: sessionId });
  }

  static async listConsultations(req: Request, res: Response) {
    const { error, value } = listConsultationsSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const consultations = await ChatSvc.listConsultations(req.organization!.id, value.caseId);
    return res.status(200).json(consultations);
  }

  static async createConsultation(req: Request, res: Response) {
    const { error, value } = createConsultationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const consultation = await ChatSvc.createConsultation(req.organization!.id, req.user.userId, value.title, value.caseId);
    return res.status(201).json(consultation);
  }

  static async renameConsultation(req: Request, res: Response) {
    const { error, value } = renameConsultationSchema.validate(req.body);
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

  static async getRelatedCases(req: Request, res: Response) {
    const { consultationId } = req.params;
    const relatedCases = await ChatSvc.getRelatedCases(req.organization!.id, req.organization!.tenantCode, consultationId);
    return res.status(200).json({ relatedCases });
  }

  /** Rank READY consultation-document chunks for a query — payload for chat-wonder grounding. */
  static async relevantChunks(req: Request, res: Response) {
    const { error, value } = relevantChunksSchema.validate(req.body, { convert: true });
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

  /**
   * Creates the AI generation job and returns immediately — it does NOT run RAG/AI generation
   * itself. ChatSvc.enqueueChatGeneration does only the fast, synchronous part (validate,
   * create the user Message row, hand off to ChatGenerationQueue); a worker owns everything
   * else (see ChatSvc.processChatGenerationJob), decoupled from this request/response entirely.
   *
   * The client gets `messageId` back to correlate live chat:chunk/chat:done/chat:error socket
   * events (see lib/socket.ts's emitToUser, already connected for push notifications — this
   * reuses that same connection/room rather than opening a second one) and to match against
   * GET /messages' replyStatus if it isn't watching the socket (a fresh page load, or the
   * socket never connected) — durable, refresh-safe status either way.
   */
  static async sendMessage(req: Request, res: Response) {
    const { consultationId } = req.params;
    const { message, sessionId, documentContext, caseDocumentId, caseId, documentIds } = req.body;

    const { error } = sendMessageSchema.validate({ message, sessionId, documentContext, caseDocumentId, caseId, documentIds });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await ChatSvc.enqueueChatGeneration(
      req.organization!.id,
      req.organization!.tenantCode,
      req.user.userId,
      consultationId,
      sessionId,
      message,
      documentContext,
      caseDocumentId,
      caseId,
      documentIds,
    );

    return res.status(202).json(result);
  }

  /**
   * Stops a turn that is still generating (the Stop button) — see ChatSvc.cancelChatGeneration.
   * 200 with the turn's resulting replyStatus, including when it was already finished/cancelled.
   */
  static async cancelMessage(req: Request, res: Response) {
    const { consultationId, messageId } = req.params;
    const result = await ChatSvc.cancelChatGeneration(
      req.organization!.id,
      req.user.userId,
      consultationId,
      messageId,
    );
    return res.status(200).json(result);
  }

  static async expandMindMapNode(req: Request, res: Response) {
    const { error, value } = expandMindMapNodeSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await MindMapSvc.expandNode({
      organizationId: req.organization!.id,
      userId: req.user.userId,
      consultationId: req.params.consultationId,
      messageId: value.messageId,
      nodeId: value.nodeId,
      count: value.count,
    });
    return res.status(200).json(result);
  }

  static async editMindMapNode(req: Request, res: Response) {
    const { error, value } = editMindMapNodeSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);
    const { messageId, ...edit } = value;
    const result = await MindMapSvc.editNode({
      organizationId: req.organization!.id,
      userId: req.user.userId,
      consultationId: req.params.consultationId,
      messageId,
      edit,
    });
    return res.status(200).json(result);
  }

  static async revertMindMap(req: Request, res: Response) {
    const { error, value } = revertMindMapSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await MindMapSvc.revert({
      organizationId: req.organization!.id,
      userId: req.user.userId,
      consultationId: req.params.consultationId,
      messageId: value.messageId,
      expectedVersion: value.version,
    });
    return res.status(200).json(result);
  }
}
