import { ClientRequestStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** A request is open until it's closed, expired or withdrawn; a case has at most one open. */
export const CLOSED_REQUEST_STATUSES: ClientRequestStatus[] = ["CLOSED", "EXPIRED", "WITHDRAWN"];

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
}
