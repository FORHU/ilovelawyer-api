import { NextFunction, Request, Response } from "express";
import SecurityAuditSvc from "../services/security-audit.service";
import { withRequestContextOf } from "../lib/request-context";

/**
 * Writes a case.item_deleted security audit row for every successful DELETE under
 * /my-cases/:caseId/... (a finding, witness, theory item, timeline entry, ...), so deletions inside
 * a case are on record without each of those services having to remember to. Mounted on the case
 * router after resolveOrganization. Deleting a whole case (DELETE /my-cases/:id) has no :caseId
 * param and is recorded by CaseSvc.delete as case.deleted instead.
 *
 * Reads the matched route once the response has gone out: only then are req.route and the
 * route's own params known, and only then is it certain the delete succeeded.
 */
export default function recordCaseItemDeletions(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "DELETE") return next();

  res.on("finish", () => {
    if (res.statusCode >= 300 || !req.route) return;
    const { caseId, itemId, eventId, id } = req.params as Record<string, string | undefined>;
    if (!caseId) return;
    void withRequestContextOf(req, () =>
      SecurityAuditSvc.record({
        action: "case.item_deleted",
        targetType: "case_item",
        targetId: itemId ?? eventId ?? id ?? null,
        caseId,
        // The route template ("/:caseId/findings/:id"), never the filled-in URL.
        payload: { route: `${req.baseUrl}${req.route.path}` },
      }),
    );
  });
  next();
}
