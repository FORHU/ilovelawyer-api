import { CaseStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** What the client app shows of a case: its details, the people in it, its documents, and the
 * one consultation its chat runs in. */
const CLIENT_CASE_INCLUDE = {
  parties: { orderBy: { id: "asc" } },
  documents: {
    where: { status: "ACTIVE" },
    select: { id: true, name: true, ragStatus: true, fileSize: true, createdAt: true },
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
  static async list(organizationId: string, status: CaseStatus = "ACTIVE") {
    return prisma.case.findMany({
      where: { organizationId, status },
      orderBy: { updatedAt: "desc" },
      include: CLIENT_CASE_INCLUDE,
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.case.findFirst({ where: { id, organizationId, status: "ACTIVE" }, include: CLIENT_CASE_INCLUDE });
  }

  /** Active or archived: for restoring and deleting an archived case. */
  static async findAnyById(id: string, organizationId: string) {
    return prisma.case.findFirst({ where: { id, organizationId }, include: CLIENT_CASE_INCLUDE });
  }

  /** Forgets the stored check, so the next read asks Jev again (the case's details changed). */
  static async clearReadiness(id: string) {
    await prisma.case.update({ where: { id }, data: { lawyerReadiness: Prisma.DbNull } });
  }

  /** Stores Jev's readiness check, and the practice area it settled on once the case is ready. */
  static async saveReadiness(id: string, readiness: Prisma.InputJsonValue, practiceArea?: string) {
    await prisma.case.update({ where: { id }, data: { lawyerReadiness: readiness, ...(practiceArea ? { practiceArea } : {}) } });
  }
}
