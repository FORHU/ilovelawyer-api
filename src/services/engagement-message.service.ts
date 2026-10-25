import type { EngagementMessageSide } from "@prisma/client";
import EngagementMessageRepo from "../repositories/engagement-message.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { openField, sealField } from "../utils/field-crypto";
import { emitToUser } from "../lib/socket";
import {
  CLIENT_HANDOFF_SOCKET_EVENTS,
  type EngagementDocumentAddedEvent,
  type EngagementMessage,
  type EngagementMessageEvent,
} from "../types/client-handoff";

/** The label sealed into every message body (utils/field-crypto): `<Model>.<field>`, which is also
 * what the data export opens it with. */
const BODY = "EngagementMessage.body";

type Side = "CLIENT" | "LAWYER";
type Thread = NonNullable<Awaited<ReturnType<typeof EngagementMessageRepo.findThread>>> & { lawyer: { id: string; name: string | null; username: string } };
type Row = Awaited<ReturnType<typeof EngagementMessageRepo.create>>;

const NOT_FOUND = () => new HttpError("Request not found", 404);
const nameOf = (u: { name: string | null; username: string } | null) => (u ? u.name || u.username : "");
const other = (side: Side): Side => (side === "LAWYER" ? "CLIENT" : "LAWYER");

/** EngagementMessage in the contract, or null when its body is sealed and can't be opened (that one
 * message is left out, so the rest of the thread still loads). */
function toDto(row: Row): EngagementMessage | null {
  const body = openField(row.body, BODY);
  if (body === null) {
    logger.warn("Engagement message left out: its body is sealed and cannot be opened", { messageId: row.id });
    return null;
  }
  return {
    id: row.id,
    requestId: row.requestId,
    author: { id: row.authorId, name: row.side === "SYSTEM" ? "ilovelawyer" : nameOf(row.author), side: row.side },
    body,
    document: row.document
      ? { id: row.document.id, filename: row.document.name, submittedBy: { id: row.document.userId, name: nameOf(row.document.user) }, submittedAt: row.document.createdAt.toISOString() }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The thread between a client and the lawyer they're engaged with (#517). It opens once the request
 * is ENGAGED and stays readable, but read-only, once it's CLOSED (409 ENGAGEMENT_CLOSED on a post).
 * Bodies are sealed like chat messages. A post reaches the other side live (engagement:message);
 * a client's message can share a document already on the case, which also tells the lawyer
 * (engagement:document-added). Each side's unread count is what the other side wrote since they
 * last read it (ClientRequest.lawyerReadAt / clientReadAt).
 */
export default class EngagementMessageSvc {
  /** The thread as the engaged lawyer sees it. 404 when they were never engaged on it. */
  static async forLawyer(lawyerId: string, requestId: string): Promise<Thread> {
    const thread = await EngagementMessageRepo.findThread(requestId);
    if (!thread?.lawyer || thread.lawyer.id !== lawyerId) throw NOT_FOUND();
    return thread as Thread;
  }

  /** The thread as the client sees it. 404 when it isn't their request; 409 before a lawyer is engaged. */
  static async forClient(clientId: string, requestId: string): Promise<Thread> {
    const thread = await EngagementMessageRepo.findThread(requestId);
    if (!thread || thread.client.id !== clientId) throw NOT_FOUND();
    if (!thread.lawyer) throw new HttpError("There's no lawyer to message yet.", 409, "INVALID_REQUEST_STATUS", { status: thread.status });
    return thread as Thread;
  }

  /** A page of the thread, oldest first, and how many of the other side's messages `side` hasn't read. */
  static async list(thread: Thread, side: Side, query: { page: number; limit: number }) {
    const readAt = side === "LAWYER" ? thread.lawyerReadAt : thread.clientReadAt;
    const [{ total, data }, unread] = await Promise.all([
      EngagementMessageRepo.list(thread.id, query.page, query.limit),
      EngagementMessageRepo.countFrom(thread.id, other(side) as EngagementMessageSide, readAt),
    ]);
    return { total, unread, data: data.flatMap((row) => toDto(row) ?? []) };
  }

  /** Marks the thread read for `side`, now. */
  static async markRead(thread: Thread, side: Side) {
    await EngagementMessageRepo.markRead(thread.id, side, new Date());
  }

  /** Posts in the thread. Only while ENGAGED. A client may share a document already on the case
   * (`documentId`), with or without text; a lawyer can't add to the client's case, so only text. */
  static async post(thread: Thread, side: Side, authorId: string, input: { body?: string; documentId?: string }): Promise<EngagementMessage> {
    if (thread.status === "CLOSED") throw new HttpError("This engagement has closed, so the thread is read-only.", 409, "ENGAGEMENT_CLOSED");
    if (thread.status !== "ENGAGED") throw new HttpError("This request isn't engaged.", 409, "INVALID_REQUEST_STATUS", { status: thread.status });
    const body = input.body?.trim() ?? "";
    const documentId = side === "CLIENT" ? (input.documentId ?? null) : null;
    if (!body && !documentId) throw new HttpError("Write a message or share a document.", 400);
    if (documentId && !(await EngagementMessageRepo.findCaseDocument(documentId, thread.caseId))) throw new HttpError("Document not found", 404);

    const row = await EngagementMessageRepo.create({ requestId: thread.id, authorId, side, body: sealField(body, BODY, true), documentId });
    // Writing in the thread means you've read it.
    await EngagementMessageRepo.markRead(thread.id, side, row.createdAt);
    const message = toDto({ ...row, body })!;

    const to = side === "LAWYER" ? thread.client.id : thread.lawyer.id;
    const event: EngagementMessageEvent = { requestId: thread.id, message };
    emitToUser(to, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_MESSAGE, event);
    if (message.document) {
      const added: EngagementDocumentAddedEvent = {
        requestId: thread.id,
        caseId: thread.caseId,
        documentId: message.document.id,
        filename: message.document.filename,
        submittedBy: message.document.submittedBy,
        submittedAt: message.document.submittedAt,
      };
      emitToUser(thread.lawyer.id, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_DOCUMENT_ADDED, added);
    }
    return message;
  }
}
