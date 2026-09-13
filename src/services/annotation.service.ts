import { AnnotationKind, AnnotationTargetType } from "@prisma/client";
import AnnotationRepo from "../repositories/annotation.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";

/**
 * Comments/disputes/alternative-readings attached to any case element (differentiation
 * program, Phase 2 — Workstream B). Read access follows ordinary CaseAccess VIEW; authoring one
 * requires EDIT — "CaseAccess VIEW users can read but not author" per the plan's verification
 * bullet. `create` here is the lawyer-initiated path (HTTP, always a real userId); the
 * DISPUTE annotation DecisionRecordSvc.dispute writes alongside flipping a decision's status
 * goes straight through AnnotationRepo instead, for the same reason DecisionRecordSvc.promote
 * skips CaseAccess — that call is already inside an access-checked action.
 */
export default class AnnotationSvc {
  static async list(caseId: string, userId: string, targetType?: AnnotationTargetType, targetId?: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return AnnotationRepo.list(caseId, targetType, targetId);
  }

  static async create(
    caseId: string,
    userId: string,
    data: { targetType: AnnotationTargetType; targetId: string; kind: AnnotationKind; body: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    return AnnotationRepo.create(caseId, { authorUserId: userId, ...data });
  }

  static async resolve(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await AnnotationRepo.setResolved(id, caseId, new Date());
    if (!row) throw new HttpError("Annotation not found", 404);
    return row;
  }

  static async reopen(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await AnnotationRepo.setResolved(id, caseId, null);
    if (!row) throw new HttpError("Annotation not found", 404);
    return row;
  }
}
