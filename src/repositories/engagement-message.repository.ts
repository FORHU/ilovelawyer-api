import type { EngagementMessageSide, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

const WITH_PEOPLE = {
  author: { select: { id: true, name: true, username: true } },
  document: { select: { id: true, name: true, userId: true, createdAt: true, user: { select: { name: true, username: true } } } },
} as const;

const PERSON = { select: { id: true, name: true, username: true } } as const;

/** The claim a thread belongs to: its lawyer, where it ended up, and each side's read marker. */
const CLAIM = { id: true, outcome: true, lawyerReadAt: true, clientReadAt: true, lawyer: PERSON } as const;

/** The request a thread is on, with one claim: what EngagementMessageSvc needs to decide who can read
 * and write. Null when there's no such request or no such claim on it. */
async function threadOf(requestId: string, claims: Prisma.ClientRequestClaimFindManyArgs["where"], orderBy?: Prisma.ClientRequestClaimOrderByWithRelationInput) {
  const request = await prisma.clientRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      caseId: true,
      client: PERSON,
      claims: { where: claims, select: CLAIM, ...(orderBy ? { orderBy } : {}), take: 1 },
    },
  });
  if (!request) return null;
  const { claims: [claim], ...rest } = request;
  return { ...rest, claim: claim ?? null };
}

/** The thread between a client and one lawyer on their request (#517; one per lawyer's claim since
 * phase 5b). `body` is stored sealed: EngagementMessageSvc seals and opens it. */
export default class EngagementMessageRepo {
  /** The request, with the lawyer's latest claim on it (null when they never joined it). */
  static async findForLawyer(requestId: string, lawyerId: string) {
    return threadOf(requestId, { lawyerId }, { claimedAt: "desc" });
  }

  /** The request, with the claim `claimId` on it, or the engaged lawyer's claim when it's left out
   * (the thread with the lawyer they hired). The claim is null when there's no such claim. */
  static async findForClient(requestId: string, claimId?: string) {
    return threadOf(requestId, claimId ? { id: claimId } : { outcome: "ENGAGED" });
  }

  /** One page of the thread, oldest first. */
  static async list(claimId: string, page: number, limit: number) {
    const where = { claimId };
    const [total, data] = await prisma.$transaction([
      prisma.engagementMessage.count({ where }),
      prisma.engagementMessage.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit, include: WITH_PEOPLE }),
    ]);
    return { total, data };
  }

  /** How many messages the other side has written since `since` (all of them when never read). */
  static async countFrom(claimId: string, side: EngagementMessageSide, since: Date | null) {
    return prisma.engagementMessage.count({ where: { claimId, side, ...(since ? { createdAt: { gt: since } } : {}) } });
  }

  static async create(data: { requestId: string; claimId: string; authorId: string; side: EngagementMessageSide; body: string; documentId: string | null }) {
    return prisma.engagementMessage.create({ data, include: WITH_PEOPLE });
  }

  static async markRead(claimId: string, side: "CLIENT" | "LAWYER", at: Date) {
    await prisma.clientRequestClaim.update({ where: { id: claimId }, data: side === "LAWYER" ? { lawyerReadAt: at } : { clientReadAt: at } });
  }

  /** A document on the case that can be shared in the thread: active, on this case. */
  static async findCaseDocument(documentId: string, caseId: string) {
    return prisma.document.findFirst({ where: { id: documentId, caseId, status: "ACTIVE" }, select: { id: true } });
  }
}
