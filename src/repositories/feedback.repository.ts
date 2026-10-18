import { FeedbackRating, FeedbackSource, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export interface ListFeedbackParams {
  page: number;
  limit: number;
  sortDir: "asc" | "desc";
  /** Matches the sender's email or name, case-insensitively. */
  q?: string;
  source?: FeedbackSource;
  rating?: FeedbackRating;
}

export interface ResolvedFeedbackReferences {
  organizations: Record<string, string>;
  cases: Record<string, string>;
}

export default class FeedbackRepo {
  static async create(data: Prisma.FeedbackUncheckedCreateInput) {
    return prisma.feedback.create({ data, select: { id: true, createdAt: true } });
  }

  static async findMessage(id: string) {
    return prisma.message.findUnique({ where: { id }, select: { id: true, consultationId: true } });
  }

  static async findConsultation(id: string) {
    return prisma.consultation.findUnique({ where: { id }, select: { id: true, userId: true, caseId: true, organizationId: true } });
  }

  /** Newest first by default. `user` is always set (the link cascades on account deletion). `resolved`
   * maps the organization and case ids in these rows to names; an id that no longer exists is simply
   * absent from it. The comment is returned as stored (sealed when field encryption was on). */
  static async list(params: ListFeedbackParams) {
    const { page, limit, sortDir, q, source, rating } = params;

    const where: Prisma.FeedbackWhereInput = {
      ...(source ? { source } : {}),
      ...(rating ? { rating } : {}),
      ...(q
        ? { user: { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } }
        : {}),
    };

    const [data, total] = await prisma.$transaction([
      prisma.feedback.findMany({
        where,
        orderBy: [{ createdAt: sortDir }, { id: sortDir }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          source: true,
          rating: true,
          category: true,
          comment: true,
          organizationId: true,
          caseId: true,
          consultationId: true,
          messageId: true,
          panelId: true,
          pagePath: true,
          userAgent: true,
          viewport: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true } },
        },
      }),
      prisma.feedback.count({ where }),
    ]);

    const organizationIds = [...new Set(data.map((row) => row.organizationId).filter((id): id is string => !!id))];
    const caseIds = [...new Set(data.map((row) => row.caseId).filter((id): id is string => !!id))];

    const [organizations, cases] = await Promise.all([
      organizationIds.length ? prisma.organization.findMany({ where: { id: { in: organizationIds } }, select: { id: true, name: true } }) : [],
      caseIds.length ? prisma.case.findMany({ where: { id: { in: caseIds } }, select: { id: true, caseName: true } }) : [],
    ]);

    const resolved: ResolvedFeedbackReferences = {
      organizations: Object.fromEntries(organizations.map((o) => [o.id, o.name])),
      cases: Object.fromEntries(cases.map((c) => [c.id, c.caseName])),
    };

    return { data, total, resolved };
  }
}
