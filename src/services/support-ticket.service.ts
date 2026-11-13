import { Prisma } from "@prisma/client";
import SupportTicketRepo, { type TicketWithMessages } from "../repositories/support-ticket.repository";
import SecurityAuditSvc from "./security-audit.service";
import { emitToUser } from "../lib/socket";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { emailLinkOriginForAccount } from "../utils/tenant-host";
import { normalizeEmail } from "../utils/auth.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import {
  SUPPORT_AUTO_RESOLVE_NOTE,
  SUPPORT_CONTEXT_LIMITS,
  SUPPORT_TICKET_AUTO_RESOLVE_DAYS,
  SUPPORT_TICKET_OVERDUE_HOURS,
  SUPPORT_TICKET_PAGE_SIZE,
} from "../constants/support-ticket.constants";
import type { SupportReplyEvent, SupportTicketContext, SupportTicketContextInput, SupportThreadDto, SupportTicketRowDto } from "../types/support-ticket";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REPLY_SUBJECT = "You have a reply from ilovelawyer support";
const FIRST_MESSAGE_PREVIEW = 140;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const asJson = (context: SupportTicketContext) => context as unknown as Prisma.InputJsonValue;

/** The page the client was on, as a path only (a query or hash can carry ids or tokens). */
function pathOf(page: string | undefined): string | null {
  const path = page?.trim().split(/[?#]/)[0] ?? "";
  return path.startsWith("/") && !path.startsWith("//") ? path.slice(0, SUPPORT_CONTEXT_LIMITS.pageLength) : null;
}

function flowPathOf(flowPath: string[] | undefined): string[] {
  return (flowPath ?? []).filter((id) => /^[\w-]+$/.test(id)).slice(0, SUPPORT_CONTEXT_LIMITS.flowPathLength);
}

function toThread(ticket: TicketWithMessages): SupportThreadDto {
  const seenAt = ticket.clientReadAt;
  return {
    id: ticket.id,
    status: ticket.status,
    messages: ticket.messages.map((m) => ({ id: m.id, author: m.author, body: m.body, createdAt: m.createdAt })),
    unreadCount: ticket.messages.filter((m) => m.author === "ADMIN" && (!seenAt || m.createdAt > seenAt)).length,
  };
}

/**
 * Support Tickets (EPIC ilovelawyer-client#120): the Support Chat's route to a person. A signed-in client
 * has one unresolved ticket at a time and new messages join it (the unique `openUserId` keeps it so, even
 * for two messages at once). OPEN means it is waiting on us, ANSWERED on the client, and an ANSWERED one
 * the client leaves for 7 days resolves itself. Text only. A signed-out visitor's ticket is tied to the
 * email they gave and is answered by email alone; it is linked to a matching client account for the admin's
 * benefit, but never joins that client's thread and nothing about the match is told to the visitor.
 */
export default class SupportTicketSvc {
  // ── the signed-in client ────────────────────────────────────────────────────────────────────────

  /** The client's open ticket, else their latest, with what they haven't read. Null if they never wrote. */
  static async getThread(userId: string): Promise<SupportThreadDto | null> {
    const ticket = await SupportTicketRepo.findCurrentForUser(userId);
    return ticket ? toThread(ticket) : null;
  }

  /** Sends a message, opening a ticket if none is open. The first message carries the context. */
  static async postClientMessage(client: { userId: string; workspaceId: string }, input: { body: string; context?: SupportTicketContextInput }) {
    const identity = await SupportTicketRepo.clientIdentity(client.userId);
    if (!identity) throw new HttpError("User not found", 404);

    for (let attempt = 0; attempt < 2; attempt++) {
      const open = await SupportTicketRepo.findOpenForUser(client.userId);
      if (open) {
        await SupportTicketRepo.appendClientMessage(open.id, input.body, client.userId, new Date());
        return toThread((await SupportTicketRepo.findById(open.id)) as TicketWithMessages);
      }
      const context = await SupportTicketSvc.contextFor(identity, input.context, client);
      try {
        const created = await SupportTicketRepo.create({
          userId: client.userId,
          openUserId: client.userId,
          email: identity.email,
          name: identity.name,
          source: "SIGNED_IN",
          flowId: context.flowPath[context.flowPath.length - 1] ?? null,
          context: asJson(context),
          firstMessage: { author: "CLIENT", authorUserId: client.userId, body: input.body },
          now: new Date(),
        });
        await SupportTicketSvc.auditOpened(created.id, client.userId, "SIGNED_IN", created.flowId);
        return toThread(created);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new HttpError("Please try again.", 409, "TICKET_CONFLICT");
  }

  static async markRead(userId: string): Promise<void> {
    const ticket = await SupportTicketRepo.findCurrentForUser(userId);
    if (ticket) await SupportTicketRepo.markRead(ticket.id, new Date());
  }

  // ── a visitor who isn't signed in ───────────────────────────────────────────────────────────────

  /** Opens a ticket for an email address. The caller has already passed the captcha and the rate limits. */
  static async openSignedOut(input: { email: string; message: string; context?: SupportTicketContextInput }): Promise<void> {
    const email = normalizeEmail(input.email);
    const linkedUserId = await SupportTicketRepo.findClientIdByEmail(email);
    const context = await SupportTicketSvc.contextFor({ name: null, email }, input.context, null);
    const created = await SupportTicketRepo.create({
      userId: linkedUserId,
      openUserId: null,
      email,
      name: null,
      source: "SIGNED_OUT",
      flowId: context.flowPath[context.flowPath.length - 1] ?? null,
      context: asJson(context),
      firstMessage: { author: "CLIENT", authorUserId: null, body: input.message },
      now: new Date(),
    });
    await SupportTicketSvc.auditOpened(created.id, null, "SIGNED_OUT", created.flowId);
  }

  // ── the admin ───────────────────────────────────────────────────────────────────────────────────

  static async adminList(query: { status?: "OPEN" | "ANSWERED" | "RESOLVED"; q?: string; sort: "age" | "updated"; page: number }, now: Date = new Date()) {
    const { total, rows } = await SupportTicketRepo.list({ ...query, limit: SUPPORT_TICKET_PAGE_SIZE });
    const data: SupportTicketRowDto[] = rows.map((t) => ({
      id: t.id,
      status: t.status,
      source: t.source,
      userId: t.userId,
      email: t.email,
      name: t.name,
      flowId: t.flowId,
      firstMessage: (t.messages[0]?.body ?? "").slice(0, FIRST_MESSAGE_PREVIEW),
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      ageHours: Math.floor((now.getTime() - t.createdAt.getTime()) / HOUR_MS),
      overdue: t.status === "OPEN" && now.getTime() - t.lastMessageAt.getTime() > SUPPORT_TICKET_OVERDUE_HOURS * HOUR_MS,
    }));
    return { total, page: query.page, pageSize: SUPPORT_TICKET_PAGE_SIZE, data };
  }

  static async adminGet(id: string, now: Date = new Date()) {
    const ticket = await SupportTicketSvc.load(id);
    const adminIds = [...new Set(ticket.messages.flatMap((m) => (m.author === "ADMIN" && m.authorUserId ? [m.authorUserId] : [])))];
    const names = await SupportTicketRepo.userNames(adminIds);
    return {
      id: ticket.id,
      status: ticket.status,
      source: ticket.source,
      userId: ticket.userId,
      email: ticket.email,
      name: ticket.name,
      flowId: ticket.flowId,
      context: ticket.context as unknown as SupportTicketContext,
      createdAt: ticket.createdAt,
      lastMessageAt: ticket.lastMessageAt,
      answeredAt: ticket.answeredAt,
      resolvedAt: ticket.resolvedAt,
      clientReadAt: ticket.clientReadAt,
      overdue: ticket.status === "OPEN" && now.getTime() - ticket.lastMessageAt.getTime() > SUPPORT_TICKET_OVERDUE_HOURS * HOUR_MS,
      messages: ticket.messages.map((m) => ({
        id: m.id,
        author: m.author,
        authorName: m.author === "ADMIN" ? (names.get(m.authorUserId ?? "") ?? "ilovelawyer support") : m.author === "CLIENT" ? (ticket.name ?? ticket.email) : "ilovelawyer",
        body: m.body,
        createdAt: m.createdAt,
      })),
    };
  }

  /** Replies, moving the ticket to ANSWERED, and tells the client: live if they're online, and by email. */
  static async adminReply(id: string, adminId: string, body: string) {
    const ticket = await SupportTicketSvc.load(id);
    const message = await SupportTicketRepo.appendAdminReply(id, body, adminId, new Date());
    if (!message) throw new HttpError("This ticket is resolved. Reopen it to reply.", 409, "TICKET_RESOLVED");

    await SecurityAuditSvc.record({
      action: "admin.support_ticket.replied",
      actorId: adminId,
      organizationId: null,
      targetType: "support_ticket",
      targetId: id,
      payload: { source: ticket.source },
    });
    await SupportTicketSvc.notifyReply(ticket, message.id, body);
    return { id: message.id, author: message.author, body: message.body, createdAt: message.createdAt, ticketStatus: "ANSWERED" as const };
  }

  static async resolve(id: string, adminId: string) {
    await SupportTicketSvc.load(id);
    if (!(await SupportTicketRepo.resolve(id, new Date()))) throw new HttpError("This ticket is already resolved.", 409, "TICKET_ALREADY_RESOLVED");
    await SecurityAuditSvc.record({ action: "admin.support_ticket.resolved", actorId: adminId, organizationId: null, targetType: "support_ticket", targetId: id });
    return SupportTicketSvc.adminGet(id);
  }

  static async reopen(id: string, adminId: string) {
    const ticket = await SupportTicketSvc.load(id);
    let reopened: boolean;
    try {
      reopened = await SupportTicketRepo.reopen(ticket, new Date());
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError("This client has another open ticket. Reply there instead.", 409, "CLIENT_HAS_OPEN_TICKET");
      throw err;
    }
    if (!reopened) throw new HttpError("Only a resolved ticket can be reopened.", 409, "TICKET_NOT_RESOLVED");
    await SecurityAuditSvc.record({ action: "admin.support_ticket.reopened", actorId: adminId, organizationId: null, targetType: "support_ticket", targetId: id });
    return SupportTicketSvc.adminGet(id);
  }

  // ── the sweep ───────────────────────────────────────────────────────────────────────────────────

  /** Resolves every ANSWERED ticket the client hasn't answered in 7 days. Returns how many. */
  static async autoResolveDue(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SUPPORT_TICKET_AUTO_RESOLVE_DAYS * DAY_MS);
    let resolved = 0;
    for (;;) {
      const due = await SupportTicketRepo.findAnsweredBefore(before, 100);
      let thisBatch = 0;
      for (const { id } of due) {
        if (!(await SupportTicketRepo.autoResolve(id, before, SUPPORT_AUTO_RESOLVE_NOTE, now))) continue;
        thisBatch++;
        await SecurityAuditSvc.record({ action: "system.support_ticket.auto_resolved", actorId: null, organizationId: null, targetType: "support_ticket", targetId: id });
      }
      resolved += thisBatch;
      if (thisBatch === 0 || due.length < 100) return resolved;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  private static async load(id: string) {
    const ticket = await SupportTicketRepo.findById(id);
    if (!ticket) throw new HttpError("Ticket not found", 404, "TICKET_NOT_FOUND");
    return ticket;
  }

  /** What the ticket carries about where it came from. The client says which case and request it was on; the
   * API keeps them only if they are the client's, adds the request's status, and never reads further. */
  private static async contextFor(
    identity: { name: string | null; email: string },
    input: SupportTicketContextInput | undefined,
    client: { userId: string; workspaceId: string } | null,
  ): Promise<SupportTicketContext> {
    const context: SupportTicketContext = {
      name: identity.name,
      email: identity.email,
      flowPath: flowPathOf(input?.flowPath),
      page: pathOf(input?.page),
      caseId: null,
      clientRequestId: null,
      clientRequestStatus: null,
    };
    if (!client) return context;
    const request = input?.clientRequestId ? await SupportTicketRepo.ownedRequest(client.userId, input.clientRequestId) : null;
    if (request) {
      context.clientRequestId = request.id;
      context.clientRequestStatus = request.status;
      context.caseId = request.caseId;
    } else if (input?.caseId) {
      context.caseId = (await SupportTicketRepo.ownedCase(client.workspaceId, input.caseId))?.id ?? null;
    }
    return context;
  }

  private static async auditOpened(ticketId: string, actorId: string | null, source: "SIGNED_IN" | "SIGNED_OUT", flowId: string | null) {
    await SecurityAuditSvc.record({
      action: "support_ticket.opened",
      actorId,
      organizationId: null,
      targetType: "support_ticket",
      targetId: ticketId,
      payload: { source, flowId },
    });
  }

  /** A signed-in client gets the socket event and an email with a link that opens the Support Chat; the
   * reply stays in the app. A visitor has no thread to open, so their email carries the reply itself. */
  private static async notifyReply(ticket: TicketWithMessages, messageId: string, body: string) {
    const signedIn = ticket.source === "SIGNED_IN" && !!ticket.userId;
    const origin = emailLinkOriginForAccount({ role: "USER" }, null);
    if (signedIn) {
      const event: SupportReplyEvent = { ticketId: ticket.id, messageId };
      emitToUser(ticket.userId as string, "support:reply", event);
    }
    try {
      const link = signedIn ? `${origin}/?support=open` : `${origin}/login`;
      const html = await renderTemplate("support-reply", {
        name: ticket.name || "there",
        signedIn,
        replyHtml: escapeHtml(body).replace(/\n/g, "<br/>"),
        link,
      });
      const text = signedIn
        ? `You have a reply from ilovelawyer support. Open it here:\n\n${link}`
        : `${body}\n\nTo reply, choose "Need help?" on the ilovelawyer sign-in page and give us this email address.\n\n${link}`;
      await sendEmail({ to: ticket.email, subject: REPLY_SUBJECT, text, html });
    } catch (err) {
      logger.error("Support ticket: reply email failed", { err, ticketId: ticket.id });
    }
  }
}
