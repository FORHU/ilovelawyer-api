import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export interface ListAuditEventsParams {
  page: number;
  limit: number;
  sortDir: "asc" | "desc";
  /** Matches the action name or the actor's email, case-insensitively. */
  q?: string;
  actorId?: string;
}

export default class AuditEventRepo {
  /** Newest first by default. `actor` is null when the user has since been deleted (the FK is
   * ON DELETE SET NULL). */
  static async list(params: ListAuditEventsParams) {
    const { page, limit, sortDir, q, actorId } = params;

    const where: Prisma.AuditEventWhereInput = {
      ...(actorId ? { actorId } : {}),
      ...(q
        ? {
            OR: [
              { action: { contains: q, mode: "insensitive" } },
              { actor: { email: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [data, total] = await prisma.$transaction([
      prisma.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: sortDir }, { id: sortDir }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          action: true,
          caseId: true,
          payload: true,
          createdAt: true,
          actor: { select: { id: true, email: true, name: true } },
        },
      }),
      prisma.auditEvent.count({ where }),
    ]);

    return { data, total };
  }
}
