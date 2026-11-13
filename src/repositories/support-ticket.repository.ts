import type { Prisma, SupportMessageAuthor, SupportTicketSource, SupportTicketStatus } from "@prisma/client";
import prisma from "../lib/prisma";

const WITH_MESSAGES = { messages: { orderBy: { createdAt: "asc" } } } satisfies Prisma.SupportTicketInclude;

export type TicketWithMessages = Prisma.SupportTicketGetPayload<{ include: typeof WITH_MESSAGES }>;

export interface NewMessage {
  author: SupportMessageAuthor;
  authorUserId?: string | null;
  body: string;
}

export interface TicketFilter {
  status?: SupportTicketStatus;
  q?: string;
  sort: "age" | "updated";
  page: number;
  limit: number;
}

/** Support Tickets and their messages (SupportTicketSvc). */
export default class SupportTicketRepo {
  /** The client's one unresolved ticket, if they have one. */
  static async findOpenForUser(userId: string) {
    return prisma.supportTicket.findUnique({ where: { openUserId: userId }, include: WITH_MESSAGES });
  }

  /** The client's open ticket, else their latest one. */
  static async findCurrentForUser(userId: string) {
    return (
      (await SupportTicketRepo.findOpenForUser(userId)) ??
      prisma.supportTicket.findFirst({ where: { userId, source: "SIGNED_IN" }, orderBy: { createdAt: "desc" }, include: WITH_MESSAGES })
    );
  }

  static async findById(id: string) {
    return prisma.supportTicket.findUnique({ where: { id }, include: WITH_MESSAGES });
  }

  /** Opens a ticket with its first message. A signed-in client's `openUserId` is what keeps them to one
   * unresolved ticket: a second create throws the unique violation. */
  static async create(data: {
    userId: string | null;
    openUserId: string | null;
    email: string;
    name: string | null;
    source: SupportTicketSource;
    flowId: string | null;
    context: Prisma.InputJsonValue;
    firstMessage: NewMessage;
    now: Date;
  }) {
    const { firstMessage, now, ...ticket } = data;
    return prisma.supportTicket.create({
      data: {
        ...ticket,
        lastMessageAt: now,
        clientReadAt: ticket.source === "SIGNED_IN" ? now : null,
        messages: { create: { author: firstMessage.author, authorUserId: firstMessage.authorUserId ?? null, body: firstMessage.body, createdAt: now } },
      },
      include: WITH_MESSAGES,
    });
  }

  /** The client writes to their open ticket: it is OPEN again if it was ANSWERED, and they have seen
   * everything up to now. */
  static async appendClientMessage(ticketId: string, body: string, userId: string, now: Date) {
    return prisma.$transaction(async (tx) => {
      await tx.supportTicketMessage.create({ data: { ticketId, author: "CLIENT", authorUserId: userId, body, createdAt: now } });
      await tx.supportTicket.update({ where: { id: ticketId }, data: { status: "OPEN", answeredAt: null, lastMessageAt: now, clientReadAt: now } });
    });
  }

  /** An admin's reply, only while the ticket is unresolved. Returns the message, or null if it was resolved. */
  static async appendAdminReply(ticketId: string, body: string, adminId: string, now: Date) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.supportTicket.updateMany({
        where: { id: ticketId, status: { in: ["OPEN", "ANSWERED"] } },
        data: { status: "ANSWERED", answeredAt: now, lastMessageAt: now },
      });
      if (count !== 1) return null;
      return tx.supportTicketMessage.create({ data: { ticketId, author: "ADMIN", authorUserId: adminId, body, createdAt: now } });
    });
  }

  static async markRead(ticketId: string, now: Date) {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { clientReadAt: now } });
  }

  /** Returns false if it was already resolved. */
  static async resolve(ticketId: string, now: Date): Promise<boolean> {
    const { count } = await prisma.supportTicket.updateMany({
      where: { id: ticketId, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now, openUserId: null },
    });
    return count === 1;
  }

  /** Returns false if it wasn't resolved. A client who has since opened another ticket makes this throw the unique violation. */
  static async reopen(ticket: { id: string; userId: string | null; source: SupportTicketSource }, now: Date): Promise<boolean> {
    const { count } = await prisma.supportTicket.updateMany({
      where: { id: ticket.id, status: "RESOLVED" },
      data: { status: "OPEN", resolvedAt: null, answeredAt: null, lastMessageAt: now, openUserId: ticket.source === "SIGNED_IN" ? ticket.userId : null },
    });
    return count === 1;
  }

  /** ANSWERED tickets nobody replied to since `before`. */
  static async findAnsweredBefore(before: Date, take: number) {
    return prisma.supportTicket.findMany({ where: { status: "ANSWERED", answeredAt: { lt: before } }, select: { id: true }, orderBy: { answeredAt: "asc" }, take });
  }

  /** Resolves it only if it is still ANSWERED and past `before`, and says so in the thread. Returns false if it moved on. */
  static async autoResolve(ticketId: string, before: Date, note: string, now: Date): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.supportTicket.updateMany({
        where: { id: ticketId, status: "ANSWERED", answeredAt: { lt: before } },
        data: { status: "RESOLVED", resolvedAt: now, openUserId: null },
      });
      if (count !== 1) return false;
      await tx.supportTicketMessage.create({ data: { ticketId, author: "SYSTEM", body: note, createdAt: now } });
      return true;
    });
  }

  static async list(filter: TicketFilter) {
    const q = filter.q?.trim();
    const where: Prisma.SupportTicketWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({
        where,
        orderBy: filter.sort === "age" ? { createdAt: "asc" } : { lastMessageAt: "desc" },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
        include: { messages: { orderBy: { createdAt: "asc" }, take: 1 } },
      }),
    ]);
    return { total, rows };
  }

  static async clientIdentity(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  }

  /** A client account (USER) with this email, to link a signed-out ticket to. */
  static async findClientIdByEmail(email: string) {
    return (await prisma.user.findFirst({ where: { email, role: "USER" }, select: { id: true } }))?.id ?? null;
  }

  static async ownedCase(workspaceId: string, caseId: string) {
    return prisma.case.findFirst({ where: { id: caseId, organizationId: workspaceId }, select: { id: true } });
  }

  static async ownedRequest(clientId: string, requestId: string) {
    return prisma.clientRequest.findFirst({ where: { id: requestId, clientId }, select: { id: true, caseId: true, status: true } });
  }

  static async userNames(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
    return new Map(users.map((u) => [u.id, u.name ?? u.email]));
  }
}
