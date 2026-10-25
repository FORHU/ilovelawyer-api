import type { EngagementMessageSide } from "@prisma/client";
import prisma from "../lib/prisma";

const WITH_PEOPLE = {
  author: { select: { id: true, name: true, username: true } },
  document: { select: { id: true, name: true, userId: true, createdAt: true, user: { select: { name: true, username: true } } } },
} as const;

/** The engagement thread (#517). `body` is stored sealed: EngagementMessageSvc seals and opens it. */
export default class EngagementMessageRepo {
  /** A request with what the thread needs: its status, case, client, and the lawyer it's engaged on
   * (the claim that ended ENGAGED). Null when there's no such request. */
  static async findThread(requestId: string) {
    const request = await prisma.clientRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        caseId: true,
        lawyerReadAt: true,
        clientReadAt: true,
        client: { select: { id: true, name: true, username: true } },
        claims: { where: { outcome: "ENGAGED" }, select: { lawyer: { select: { id: true, name: true, username: true } } }, take: 1 },
      },
    });
    if (!request) return null;
    const lawyer = request.claims[0]?.lawyer ?? null;
    return { ...request, lawyer };
  }

  /** One page of the thread, oldest first. */
  static async list(requestId: string, page: number, limit: number) {
    const where = { requestId };
    const [total, data] = await prisma.$transaction([
      prisma.engagementMessage.count({ where }),
      prisma.engagementMessage.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit, include: WITH_PEOPLE }),
    ]);
    return { total, data };
  }

  /** How many messages the other side has written since `since` (all of them when never read). */
  static async countFrom(requestId: string, side: EngagementMessageSide, since: Date | null) {
    return prisma.engagementMessage.count({ where: { requestId, side, ...(since ? { createdAt: { gt: since } } : {}) } });
  }

  static async create(data: { requestId: string; authorId: string; side: EngagementMessageSide; body: string; documentId: string | null }) {
    return prisma.engagementMessage.create({ data, include: WITH_PEOPLE });
  }

  static async markRead(requestId: string, side: "CLIENT" | "LAWYER", at: Date) {
    await prisma.clientRequest.update({ where: { id: requestId }, data: side === "LAWYER" ? { lawyerReadAt: at } : { clientReadAt: at } });
  }

  /** A document on the case that can be shared in the thread: active, on this case. */
  static async findCaseDocument(documentId: string, caseId: string) {
    return prisma.document.findFirst({ where: { id: documentId, caseId, status: "ACTIVE" }, select: { id: true } });
  }
}
