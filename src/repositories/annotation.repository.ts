import prisma from "../lib/prisma";
import { AnnotationKind, AnnotationTargetType } from "@prisma/client";

export interface AnnotationCreateInput {
  authorUserId: string | null;
  targetType: AnnotationTargetType;
  targetId: string;
  kind: AnnotationKind;
  body: string;
}

export default class AnnotationRepo {
  static async create(caseId: string, data: AnnotationCreateInput) {
    return prisma.annotation.create({ data: { caseId, ...data } });
  }

  /** Scoped to one target when both are given (the normal case — a drawer for one decision,
   * one graph node, etc); caseId-only listing is for a future case-wide activity view. */
  static async list(caseId: string, targetType?: AnnotationTargetType, targetId?: string) {
    return prisma.annotation.findMany({
      where: { caseId, ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  static async findById(id: string, caseId: string) {
    return prisma.annotation.findFirst({ where: { id, caseId } });
  }

  static async setResolved(id: string, caseId: string, resolvedAt: Date | null) {
    const result = await prisma.annotation.updateMany({ where: { id, caseId }, data: { resolvedAt } });
    if (result.count === 0) return null;
    return AnnotationRepo.findById(id, caseId);
  }
}
