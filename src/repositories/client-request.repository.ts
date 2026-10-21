import { ClientRequestStatus } from "@prisma/client";
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

  static async hasCasePayment(caseId: string): Promise<boolean> {
    return (await prisma.clientPayment.count({ where: { caseId, kind: "CASE", status: "SUCCEEDED" } })) > 0;
  }
}
