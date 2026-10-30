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

/** What a client is called in a thread with a lawyer they haven't hired: the brief is anonymised
 * until then (phase 5b). */
const ANONYMOUS_CLIENT = "Client";

type Side = "CLIENT" | "LAWYER";
type Found = NonNullable<Awaited<ReturnType<typeof EngagementMessageRepo.findForLawyer>>>;
type Thread = Found & { claim: NonNullable<Found["claim"]> };
type Row = Awaited<ReturnType<typeof EngagementMessageRepo.create>>;

/** Where a thread is: BEFORE_HIRE (the lawyer is on the request; text only), ENGAGED (hired; the
 * client can share documents), CLOSED (the engagement ended) or ENDED (the lawyer's claim ended:
 * time ran out, released, declined or not chosen). The last two are read-only. */
type ThreadState = "BEFORE_HIRE" | "ENGAGED" | "CLOSED" | "ENDED";

/** Statuses a request is in while lawyers are on it and none is hired yet. CLAIMED and QUOTED are
 * from before phase 5; CONFIRMED is while the chosen lawyer's fee is charged. */
const BEFORE_HIRE = ["ROUTED", "CLAIMED", "QUOTED", "CONFIRMED"];

const NOT_FOUND = () => new HttpError("Request not found", 404);
const nameOf = (u: { name: string | null; username: string } | null) => (u ? u.name || u.username : "");
const other = (side: Side): Side => (side === "LAWYER" ? "CLIENT" : "LAWYER");

function stateOf(thread: Thread): ThreadState {
  const { outcome } = thread.claim;
  if (outcome === null && BEFORE_HIRE.includes(thread.status)) return "BEFORE_HIRE";
  if (outcome === "ENGAGED" && thread.status === "ENGAGED") return "ENGAGED";
  if (outcome === "ENGAGED" && thread.status === "CLOSED") return "CLOSED";
  return "ENDED";
}

/** EngagementMessage in the contract, or null when its body is sealed and can't be opened (that one
 * message is left out, so the rest of the thread still loads). Until the lawyer is hired, the
 * client's messages carry no name or id. */
function toDto(row: Row, hired: boolean): EngagementMessage | null {
  const body = openField(row.body, BODY);
  if (body === null) {
    logger.warn("Engagement message left out: its body is sealed and cannot be opened", { messageId: row.id });
    return null;
  }
  const anonymous = row.side === "CLIENT" && !hired;
  return {
    id: row.id,
    requestId: row.requestId,
    claimId: row.claimId,
    author: {
      id: anonymous ? null : row.authorId,
      name: row.side === "SYSTEM" ? "ilovelawyer" : anonymous ? ANONYMOUS_CLIENT : nameOf(row.author),
      side: row.side,
    },
    body,
    document: row.document
      ? { id: row.document.id, filename: row.document.name, submittedBy: { id: row.document.userId, name: nameOf(row.document.user) }, submittedAt: row.document.createdAt.toISOString() }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The thread between a client and one lawyer on their request (#517). Since phase 5b each lawyer
 * who joins has their own, opening when they join: either side can write while the lawyer is on the
 * request, text only, and the lawyer sees the client as "Client" until hired. Once hired, the client
 * can also share a document already on the case. It turns read-only when the lawyer's claim ends
 * (409 THREAD_CLOSED) or the engagement closes (409 ENGAGEMENT_CLOSED). Bodies are sealed like chat
 * messages. A post reaches the other side live (engagement:message). Each side's unread count is
 * what the other side wrote since they last read it (ClientRequestClaim.lawyerReadAt / clientReadAt).
 */
export default class EngagementMessageSvc {
  /** The lawyer's thread on a request: their latest claim on it. 404 when they never joined it. */
  static async forLawyer(lawyerId: string, requestId: string): Promise<Thread> {
    const thread = await EngagementMessageRepo.findForLawyer(requestId, lawyerId);
    if (!thread?.claim) throw NOT_FOUND();
    return thread as Thread;
  }

  /** The client's thread with one lawyer (`claimId`), or with the lawyer they hired when it's left
   * out. 404 when it isn't their request or that claim isn't on it; 409 when no lawyer is hired and
   * no claim was named. */
  static async forClient(clientId: string, requestId: string, claimId?: string): Promise<Thread> {
    const thread = await EngagementMessageRepo.findForClient(requestId, claimId);
    if (!thread || thread.client.id !== clientId) throw NOT_FOUND();
    if (!thread.claim) {
      if (claimId) throw NOT_FOUND();
      throw new HttpError("There's no lawyer to message yet.", 409, "INVALID_REQUEST_STATUS", { status: thread.status });
    }
    return thread as Thread;
  }

  /** A page of the thread, oldest first, and how many of the other side's messages `side` hasn't read. */
  static async list(thread: Thread, side: Side, query: { page: number; limit: number }) {
    const readAt = side === "LAWYER" ? thread.claim.lawyerReadAt : thread.claim.clientReadAt;
    const hired = thread.claim.outcome === "ENGAGED";
    const [{ total, data }, unread] = await Promise.all([
      EngagementMessageRepo.list(thread.claim.id, query.page, query.limit),
      EngagementMessageRepo.countFrom(thread.claim.id, other(side) as EngagementMessageSide, readAt),
    ]);
    return { total, unread, data: data.flatMap((row) => toDto(row, hired) ?? []) };
  }

  /** Marks the thread read for `side`, now. */
  static async markRead(thread: Thread, side: Side) {
    await EngagementMessageRepo.markRead(thread.claim.id, side, new Date());
  }

  /** Posts in the thread, while the lawyer is on the request or engaged. Once hired, a client may
   * share a document already on the case (`documentId`), with or without text; before that, and for
   * a lawyer, who can't add to the client's case, only text. */
  static async post(thread: Thread, side: Side, authorId: string, input: { body?: string; documentId?: string }): Promise<EngagementMessage> {
    const state = stateOf(thread);
    if (state === "CLOSED") throw new HttpError("This engagement has closed, so the thread is read-only.", 409, "ENGAGEMENT_CLOSED");
    if (state === "ENDED") throw new HttpError("This lawyer is no longer on the request, so the thread is read-only.", 409, "THREAD_CLOSED");
    const body = input.body?.trim() ?? "";
    const documentId = side === "CLIENT" ? (input.documentId ?? null) : null;
    if (documentId && state !== "ENGAGED") throw new HttpError("You can share documents once you've hired this lawyer.", 400, "DOCUMENTS_AFTER_HIRE");
    if (!body && !documentId) throw new HttpError("Write a message or share a document.", 400);
    if (documentId && !(await EngagementMessageRepo.findCaseDocument(documentId, thread.caseId))) throw new HttpError("Document not found", 404);

    const row = await EngagementMessageRepo.create({ requestId: thread.id, claimId: thread.claim.id, authorId, side, body: sealField(body, BODY, true), documentId });
    // Writing in the thread means you've read it.
    await EngagementMessageRepo.markRead(thread.claim.id, side, row.createdAt);
    const message = toDto({ ...row, body }, state === "ENGAGED")!;

    const to = side === "LAWYER" ? thread.client.id : thread.claim.lawyer.id;
    const event: EngagementMessageEvent = { requestId: thread.id, claimId: thread.claim.id, message };
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
      emitToUser(thread.claim.lawyer.id, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_DOCUMENT_ADDED, added);
    }
    return message;
  }
}
