import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** What the client app shows of a case: its details, the people in it, its documents, and the
 * one consultation its chat runs in. */
const CLIENT_CASE_INCLUDE = {
  parties: { orderBy: { id: "asc" } },
  documents: {
    where: { status: "ACTIVE" },
    select: { id: true, name: true, ragStatus: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  },
  consultations: {
    where: { status: "ACTIVE" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 1,
  },
} as const;

export type ClientCaseRow = NonNullable<Awaited<ReturnType<typeof ClientCaseRepo.findById>>>;

export default class ClientCaseRepo {
  /** A client's cases, all in their personal workspace, most recently changed first. */
  static async list(organizationId: string) {
    return prisma.case.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      include: CLIENT_CASE_INCLUDE,
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.case.findFirst({ where: { id, organizationId, status: "ACTIVE" }, include: CLIENT_CASE_INCLUDE });
  }

  /** Stores Jev's readiness check, and the practice area it settled on once the case is ready. */
  static async saveReadiness(id: string, readiness: Prisma.InputJsonValue, practiceArea?: string) {
    await prisma.case.update({ where: { id }, data: { lawyerReadiness: readiness, ...(practiceArea ? { practiceArea } : {}) } });
  }
}
