import { ClaimOutcome, ClientRequestStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { PRACTICE_AREAS_INCLUDE } from "./practice-area.repository";

/** A request is open until it's closed, expired or withdrawn; a case has at most one open. */
export const CLOSED_REQUEST_STATUSES: ClientRequestStatus[] = ["CLOSED", "EXPIRED", "WITHDRAWN"];

/** How long a routed request stays open to lawyers joining it before EXPIRED (#510) acts on it. */
export const ROUTING_WINDOW_MS = 48 * 60 * 60 * 1000;

/** A routed request has run out when its 48h are over with no lawyer on it, or when the client
 * hasn't picked a quote by its pick-by date (several lawyers, phase 5). */
function expiredWhere(now: Date): Prisma.ClientRequestWhereInput {
  return { status: "ROUTED", OR: [{ routingExpiresAt: { lte: now }, claims: { none: { outcome: null } } }, { pickByAt: { lte: now } }] };
}

/** How a claim ends without an engagement: these show in the lawyer's history straight away. */
const ENDED_OUTCOMES: ClaimOutcome[] = ["RELEASED", "LAPSED", "DECLINED", "REASSIGNED", "WITHDRAWN", "NOT_CHOSEN"];

/** What the lawyer app reads of a request (#511): the case's practice area and jurisdiction for
 * matching, and every claim on it, newest first, with the claiming lawyer's name. */
const FOR_LAWYER = {
  case: { select: { caseName: true, caseAreas: true, ukJurisdiction: true, organizationId: true, organization: { select: { name: true } } } },
  client: { select: { id: true, name: true, username: true } },
  claims: { orderBy: { claimedAt: "desc" }, include: { lawyer: { select: { id: true, name: true } } } },
  // The per-case fee (#513), from CONFIRMED.
  charges: { where: { kind: "PER_CASE_FEE" } },
} satisfies Prisma.ClientRequestInclude;

/** What the client app reads of a request (#512; several lawyers in phase 5): every lawyer on it now
 * (an open claim, quoted or not) or engaged on it, oldest first, with what the client may see of the
 * lawyer and their firm. */
const FOR_CLIENT = {
  claims: {
    where: { OR: [{ outcome: null }, { outcome: "ENGAGED" }] },
    orderBy: { claimedAt: "asc" },
    include: {
      lawyer: {
        select: {
          id: true,
          name: true,
          avatar: { select: { s3Key: true } },
          clientRequestProfile: { include: { ukRegistration: true, ...PRACTICE_AREAS_INCLUDE } },
        },
      },
      organization: { select: { name: true, isPersonal: true } },
    },
  },
  feedback: true,
} satisfies Prisma.ClientRequestInclude;

export type ClientRequestForClient = Prisma.ClientRequestGetPayload<{ include: typeof FOR_CLIENT }>;

export default class ClientRequestRepo {
  static async create(data: { caseId: string; clientId: string; note: string; consentVersion: string; consentAcceptedAt: Date }) {
    return prisma.clientRequest.create({ data });
  }

  /** The case's open request with its status, for deciding what a change to the case may do. */
  /** The case's open request, with how many lawyers are on it now (open claims). */
  static async findLiveForCase(caseId: string) {
    const live = await prisma.clientRequest.findFirst({
      where: { caseId, status: { notIn: CLOSED_REQUEST_STATUSES } },
      select: { id: true, status: true, _count: { select: { claims: { where: { outcome: null } } } } },
    });
    return live ? { id: live.id, status: live.status, lawyersOn: live._count.claims } : null;
  }

  static async findOpenForCase(caseId: string) {
    return prisma.clientRequest.findFirst({ where: { caseId, status: { notIn: CLOSED_REQUEST_STATUSES } }, select: { id: true } });
  }

  /** Records the engaged lawyer's finished workspace copy (#514), once CaseCopyQueue makes one. */
  static async setCopyCaseId(id: string, copyCaseId: string) {
    await prisma.clientRequest.update({ where: { id }, data: { copyCaseId } });
  }

  /** The lawyer with live, read-only access to this case right now, and who to credit a new
   * document to (#514) — null when nobody's engaged on it. */
  static async findEngagedLawyerForCase(caseId: string) {
    const request = await prisma.clientRequest.findFirst({
      where: { caseId, status: "ENGAGED" },
      select: {
        id: true,
        client: { select: { id: true, name: true, username: true } },
        // The engaged lawyer's claim: confirming ends it ENGAGED (OrganizationChargeRepo.settle).
        claims: { where: { outcome: "ENGAGED" }, select: { lawyerId: true } },
      },
    });
    const lawyerId = request?.claims[0]?.lawyerId;
    if (!request || !lawyerId) return null;
    return { requestId: request.id, lawyerId, client: { id: request.client.id, name: request.client.name || request.client.username } };
  }

  /** The engagement a lawyer's workspace copy belongs to (#515), with who to tell about its AI
   * budget — null for a case that isn't one, or whose engagement has no assigned lawyer any more
   * (closed and reassigned have both kept the same claim's outcome, so this still resolves after
   * close; a withdrawn or expired request was never engaged, so it was never copied). */
  static async findByCopyCaseId(caseId: string) {
    const request = await prisma.clientRequest.findFirst({
      where: { copyCaseId: caseId },
      select: { id: true, copyCaseId: true, claims: { where: { outcome: "ENGAGED" }, select: { lawyerId: true } } },
    });
    if (!request) return null;
    return { id: request.id, copyCaseId: request.copyCaseId!, lawyerId: request.claims[0]?.lawyerId ?? null };
  }

  /** Only the client's own. */
  static async findForClient(id: string, clientId: string) {
    return prisma.clientRequest.findFirst({ where: { id, clientId }, include: FOR_CLIENT });
  }

  static async listForClient(clientId: string, caseId: string | undefined, page: number, limit: number) {
    const where = { clientId, ...(caseId ? { caseId } : {}) };
    const [total, data] = await prisma.$transaction([
      prisma.clientRequest.count({ where }),
      prisma.clientRequest.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, include: FOR_CLIENT }),
    ]);
    return { total, data };
  }

  /** The client takes the request back (#507): WITHDRAWN if it's still in one of `from`, ending every
   * open claim with it (#511; several lawyers in phase 5). `heldBy`: the lawyers whose claims ended. */
  static async withdraw(id: string, from: ClientRequestStatus[], now: Date = new Date()): Promise<{ moved: boolean; heldBy: string[] }> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.clientRequest.updateMany({ where: { id, status: { in: from } }, data: { status: "WITHDRAWN", withdrawnAt: now } });
      if (count !== 1) return { moved: false, heldBy: [] };
      const open = await tx.clientRequestClaim.findMany({ where: { requestId: id, outcome: null }, select: { lawyerId: true } });
      await tx.clientRequestClaim.updateMany({ where: { requestId: id, outcome: null }, data: { outcome: "WITHDRAWN", endedAt: now } });
      return { moved: true, heldBy: open.map((c) => c.lawyerId) };
    });
  }

  /** Moves the request on only if it's still in one of `from`, so two changes can't both win. */
  static async transition(id: string, from: ClientRequestStatus[], data: { status: ClientRequestStatus; withdrawnAt?: Date }) {
    const { count } = await prisma.clientRequest.updateMany({ where: { id, status: { in: from } }, data });
    return count === 1;
  }

  /** Either side ending the engagement (#519): ENGAGED -> CLOSED, once. True when this call moved
   * it; false when it had already closed, expired or moved on some other way. */
  static async close(id: string, closedBy: "LAWYER" | "CLIENT", now: Date = new Date()): Promise<boolean> {
    const { count } = await prisma.clientRequest.updateMany({ where: { id, status: "ENGAGED" }, data: { status: "CLOSED", closedAt: now, closedBy } });
    return count === 1;
  }

  /** The client's rating of the lawyer, once the engagement is CLOSED. Null when already given:
   * EngagementFeedback.requestId is unique, so a second attempt would otherwise throw. */
  static async createFeedback(requestId: string, rating: number, comment: string | null) {
    try {
      return await prisma.engagementFeedback.create({ data: { requestId, rating, comment } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  }

  /** Everything the brief is written from (#508): the case, its parties and documents (names only,
   * so they can be taken out), the chat's consultation, and the client's name. */
  static async findForBrief(id: string) {
    return prisma.clientRequest.findUnique({
      where: { id },
      include: {
        client: { select: { name: true, username: true } },
        case: {
          select: {
            caseName: true,
            caseAreas: true,
            ukJurisdiction: true,
            jurisdiction: true,
            clientSide: true,
            parties: { select: { name: true, designation: true }, orderBy: { id: "asc" } },
            documents: { where: { status: "ACTIVE" }, select: { id: true, name: true, ragStatus: true }, orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
  }

  static async saveBrief(id: string, data: { brief: Prisma.InputJsonValue; briefFingerprint: string; briefGeneratedAt: Date } | { briefError: string }) {
    await prisma.clientRequest.update({ where: { id }, data: "briefError" in data ? data : { ...data, briefError: null } });
  }


  /** REQUESTED -> ROUTED, right after create() — nothing else touches a brand new request at the
   * same instant, so this doesn't need transition()'s guard. */
  static async route(id: string) {
    return prisma.clientRequest.update({
      where: { id },
      data: { status: "ROUTED", routedAt: new Date(), routingExpiresAt: new Date(Date.now() + ROUTING_WINDOW_MS) },
    });
  }

  /** The case's practice area and jurisdiction, and who's already excluded (#509's matching). */
  static async findForMatching(id: string) {
    return prisma.clientRequest.findUnique({
      where: { id },
      select: { excludedLawyerIds: true, case: { select: { caseAreas: true, ukJurisdiction: true } } },
    });
  }

  static async findForLawyer(id: string) {
    return prisma.clientRequest.findUnique({ where: { id }, include: FOR_LAWYER });
  }

  /** The inbox's candidates (#511): routed, inside the 48h, with a brief to read, not excluded
   * for this lawyer, and in the case areas their practice areas map to (caseAreasOf) and their
   * jurisdictions. Newest routing first. ClientRequestMatchingSvc.matches has the final say. */
  static async listRoutedFor(lawyerId: string, areas: { caseAreas: string[]; jurisdictions: string[] }, now: Date) {
    return prisma.clientRequest.findMany({
      where: {
        status: "ROUTED",
        routingExpiresAt: { gt: now },
        briefGeneratedAt: { not: null },
        NOT: { excludedLawyerIds: { has: lawyerId } },
        case: { caseAreas: { hasSome: areas.caseAreas }, ukJurisdiction: { in: areas.jurisdictions } },
      },
      orderBy: [{ routedAt: "desc" }, { id: "asc" }],
      include: FOR_LAWYER,
    });
  }

  /** mine: requests the lawyer holds (an open claim) or is engaged on. history: the ones they held
   * that ended, including an engagement once it's closed. Most recently changed first. */
  static async listHeldBy(lawyerId: string, view: "mine" | "history", page: number, limit: number) {
    const engaged = { claims: { some: { lawyerId, outcome: "ENGAGED" as const } } };
    const where: Prisma.ClientRequestWhereInput =
      view === "mine"
        ? { OR: [{ claims: { some: { lawyerId, outcome: null } } }, { status: "ENGAGED", ...engaged }] }
        : { OR: [{ claims: { some: { lawyerId, outcome: { in: ENDED_OUTCOMES } } } }, { status: { not: "ENGAGED" }, ...engaged }] };
    const [total, data] = await prisma.$transaction([
      prisma.clientRequest.count({ where }),
      prisma.clientRequest.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit, include: FOR_LAWYER }),
    ]);
    return { total, data };
  }

  /** Takes the right to announce a request to its lawyers (#510): true for exactly one caller, and
   * only while it's routed with a brief to read and nobody has been told yet. Taken before
   * anything is sent, so two runs can't both send. */
  static async claimAnnouncement(id: string, now: Date): Promise<boolean> {
    const { count } = await prisma.clientRequest.updateMany({
      where: { id, status: "ROUTED", announcedAt: null, briefGeneratedAt: { not: null } },
      data: { announcedAt: now },
    });
    return count === 1;
  }

  /** Routed requests with a brief that nobody has been told about yet, still inside their 48h: the
   * brief landed before routing, a send failed, or a claim ended and put it back in the pool. */
  static async findUnannounced(now: Date) {
    return prisma.clientRequest.findMany({
      where: { status: "ROUTED", announcedAt: null, briefGeneratedAt: { not: null }, routingExpiresAt: { gt: now } },
      select: { id: true },
      orderBy: { routedAt: "asc" },
    });
  }

  /** What the announcement says: the brief's urgency, the case's area and part of the UK, and when
   * the routing window closes. */
  static async findForAnnouncement(id: string) {
    return prisma.clientRequest.findUnique({
      where: { id },
      select: { id: true, brief: true, routingExpiresAt: true, case: { select: { caseAreas: true, ukJurisdiction: true } } },
    });
  }

  /** Routed requests that have run out (expiredWhere), with what the client and ops are told. */
  static async findExpired(now: Date) {
    return prisma.clientRequest.findMany({
      where: expiredWhere(now),
      select: {
        id: true,
        caseId: true,
        clientId: true,
        routedAt: true,
        pickByAt: true,
        case: { select: { caseAreas: true, ukJurisdiction: true } },
        client: { select: { email: true } },
      },
      orderBy: { routingExpiresAt: "asc" },
    });
  }

  /** ROUTED -> EXPIRED, only if it has still run out (expiredWhere): a lawyer who joined or a pick
   * that got in first wins. Any claim still open ends NOT_CHOSEN with it. */
  static async expire(id: string, now: Date): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.clientRequest.updateMany({ where: { id, ...expiredWhere(now) }, data: { status: "EXPIRED" } });
      if (count !== 1) return false;
      await tx.clientRequestClaim.updateMany({ where: { requestId: id, outcome: null }, data: { outcome: "NOT_CHOSEN", endedAt: now } });
      return true;
    });
  }

  /** The names behind the anonymised brief, for the claiming lawyer's conflict check (#512): the
   * client, and the case's other parties as the client entered them. */
  static async findParties(id: string) {
    return prisma.clientRequest.findUnique({
      where: { id },
      select: {
        caseId: true,
        client: { select: { name: true, username: true } },
        case: { select: { parties: { select: { name: true, designation: true }, orderBy: { id: "asc" } } } },
      },
    });
  }

  /** The engaged lawyer's full intake package (ADR 0018, #514-adjacent): everything FOR_LAWYER
   * leaves out because it's party/client-identifying — the case's own fields, the client's note,
   * and the case's documents. Its own query, like findForBrief/findParties, rather than widening
   * FOR_LAWYER (read by every lawyer before they've engaged, and by the inbox list). */
  static async findForIntakePackage(id: string) {
    return prisma.clientRequest.findUnique({
      where: { id },
      select: {
        caseId: true,
        note: true,
        case: {
          select: {
            caseName: true,
            caseAreas: true,
            ukJurisdiction: true,
            jurisdiction: true,
            clientSide: true,
            parties: { select: { name: true, designation: true }, orderBy: { id: "asc" } },
            documents: {
              where: { status: "ACTIVE" },
              select: { id: true, name: true, ragStatus: true, category: true, file: { select: { s3Key: true, fileUrl: true, filename: true } } },
              orderBy: { createdAt: "asc" },
            },
            consultations: { where: { status: "ACTIVE" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 },
          },
        },
      },
    });
  }

  /** Stops one lawyer seeing a request again (a pass, #511). Status untouched. */
  static async exclude(id: string, lawyerId: string) {
    await prisma.clientRequest.updateMany({
      where: { id, NOT: { excludedLawyerIds: { has: lawyerId } } },
      data: { excludedLawyerIds: { push: lawyerId } },
    });
  }
}
