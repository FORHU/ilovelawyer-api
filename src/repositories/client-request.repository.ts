import { ClaimOutcome, ClientRequestStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** A request is open until it's closed, expired or withdrawn; a case has at most one open. */
export const CLOSED_REQUEST_STATUSES: ClientRequestStatus[] = ["CLOSED", "EXPIRED", "WITHDRAWN"];

/** How long a routed request stays open to a claim before EXPIRED (#510) acts on it. */
export const ROUTING_WINDOW_MS = 48 * 60 * 60 * 1000;

/** CLAIMED or QUOTED is where a held request re-enters the pool from (#511, #512). */
const REROUTABLE: ClientRequestStatus[] = ["CLAIMED", "QUOTED"];

/** How a claim ends without an engagement: these show in the lawyer's history straight away. */
const ENDED_OUTCOMES: ClaimOutcome[] = ["RELEASED", "LAPSED", "DECLINED", "REASSIGNED", "WITHDRAWN"];

/** What the lawyer app reads of a request (#511): the case's practice area and jurisdiction for
 * matching, and every claim on it, newest first, with the claiming lawyer's name. */
const FOR_LAWYER = {
  case: { select: { practiceArea: true, ukJurisdiction: true } },
  claims: { orderBy: { claimedAt: "desc" }, include: { lawyer: { select: { id: true, name: true } } } },
} satisfies Prisma.ClientRequestInclude;

export default class ClientRequestRepo {
  static async create(data: { caseId: string; clientId: string; note: string; consentVersion: string; consentAcceptedAt: Date }) {
    return prisma.clientRequest.create({ data });
  }

  static async findOpenForCase(caseId: string) {
    return prisma.clientRequest.findFirst({ where: { caseId, status: { notIn: CLOSED_REQUEST_STATUSES } }, select: { id: true } });
  }

  /** Only the client's own. */
  static async findForClient(id: string, clientId: string) {
    return prisma.clientRequest.findFirst({ where: { id, clientId } });
  }

  static async listForClient(clientId: string, caseId: string | undefined, page: number, limit: number) {
    const where = { clientId, ...(caseId ? { caseId } : {}) };
    const [total, data] = await prisma.$transaction([
      prisma.clientRequest.count({ where }),
      prisma.clientRequest.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  /** The client takes the request back (#507): WITHDRAWN if it's still in one of `from`, ending any
   * open claim with it (#511). `heldBy` is the lawyer whose claim ended, if any. */
  static async withdraw(id: string, from: ClientRequestStatus[], now: Date = new Date()): Promise<{ moved: boolean; heldBy: string | null }> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.clientRequest.updateMany({ where: { id, status: { in: from } }, data: { status: "WITHDRAWN", withdrawnAt: now } });
      if (count !== 1) return { moved: false, heldBy: null };
      const open = await tx.clientRequestClaim.findFirst({ where: { requestId: id, outcome: null }, select: { id: true, lawyerId: true } });
      if (open) await tx.clientRequestClaim.update({ where: { id: open.id }, data: { outcome: "WITHDRAWN", endedAt: now, openRequestId: null } });
      return { moved: true, heldBy: open?.lawyerId ?? null };
    });
  }

  /** Moves the request on only if it's still in one of `from`, so two changes can't both win. */
  static async transition(id: string, from: ClientRequestStatus[], data: { status: ClientRequestStatus; withdrawnAt?: Date }) {
    const { count } = await prisma.clientRequest.updateMany({ where: { id, status: { in: from } }, data });
    return count === 1;
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
            practiceArea: true,
            ukJurisdiction: true,
            jurisdiction: true,
            clientSide: true,
            parties: { select: { name: true, designation: true }, orderBy: { id: "asc" } },
            documents: { where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } },
            consultations: { where: { status: "ACTIVE" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 },
          },
        },
      },
    });
  }

  static async saveBrief(id: string, data: { brief: Prisma.InputJsonValue; briefFingerprint: string; briefGeneratedAt: Date } | { briefError: string }) {
    await prisma.clientRequest.update({ where: { id }, data: "briefError" in data ? data : { ...data, briefError: null } });
  }

  static async hasCasePayment(caseId: string): Promise<boolean> {
    return (await prisma.clientPayment.count({ where: { caseId, kind: "CASE", status: "SUCCEEDED" } })) > 0;
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
      select: { excludedLawyerIds: true, case: { select: { practiceArea: true, ukJurisdiction: true } } },
    });
  }

  static async findForLawyer(id: string) {
    return prisma.clientRequest.findUnique({ where: { id }, include: FOR_LAWYER });
  }

  /** The inbox's candidates (#511): routed, inside the 48h, with a brief to read, not excluded
   * for this lawyer, and in their practice areas and jurisdictions. Newest routing first.
   * ClientRequestMatchingSvc.matches has the final say. */
  static async listRoutedFor(lawyerId: string, areas: { practiceAreas: string[]; jurisdictions: string[] }, now: Date) {
    return prisma.clientRequest.findMany({
      where: {
        status: "ROUTED",
        routingExpiresAt: { gt: now },
        briefGeneratedAt: { not: null },
        NOT: { excludedLawyerIds: { has: lawyerId } },
        case: { practiceArea: { in: areas.practiceAreas }, ukJurisdiction: { in: areas.jurisdictions } },
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

  /** Stops one lawyer seeing a request again (a pass, #511). Status untouched. */
  static async exclude(id: string, lawyerId: string) {
    await prisma.clientRequest.updateMany({
      where: { id, NOT: { excludedLawyerIds: { has: lawyerId } } },
      data: { excludedLawyerIds: { push: lawyerId } },
    });
  }

  /** Puts a held request back in the pool without one lawyer (#511 pass/release, #512 decline) —
   * guarded, since a lapse timer and a manual action can race for the same request. */
  static async reroute(id: string, excludeLawyerId: string): Promise<boolean> {
    const { count } = await prisma.clientRequest.updateMany({
      where: { id, status: { in: REROUTABLE } },
      data: {
        status: "ROUTED",
        routedAt: new Date(),
        routingExpiresAt: new Date(Date.now() + ROUTING_WINDOW_MS),
        // Announced again to whoever matches now (#510).
        announcedAt: null,
        excludedLawyerIds: { push: excludeLawyerId },
      },
    });
    return count === 1;
  }
}
