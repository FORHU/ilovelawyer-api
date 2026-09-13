import { DecisionStatus, Prisma } from "@prisma/client";
import DecisionRecordRepo from "../repositories/decision-record.repository";
import CaseAccess from "../utils/case-access";
import CaseGraphSvc from "./case-graph.service";
import CaseEdgeRepo from "../repositories/case-edge.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AnnotationRepo from "../repositories/annotation.repository";
import HttpError from "../utils/http-error";
import { DecisionRecordItem } from "../utils/response-parser";

/**
 * Case-level Decision Records (differentiation program, Phase 1) — see
 * docs/plans/differentiation-program.md Workstream A and prisma/schema.prisma's
 * DecisionRecord doc comment. `promote` is called from ChatSvc.persistAssistantTurn, not from
 * an HTTP request, so — like CaseTimelineSvc.promoteFromAi — it does no CaseAccess check and
 * writes no audit event: the turn that produced these records already ran on behalf of this
 * case. Every other method here is a normal user-initiated action and goes through CaseAccess.
 */
export default class DecisionRecordSvc {
  static async list(caseId: string, userId: string, status?: DecisionStatus) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return DecisionRecordRepo.list(caseId, status);
  }

  /**
   * Flips status to DISPUTED and, per docs/plans/differentiation-program.md Workstream B, also
   * writes a DISPUTE Annotation targeting this record — so the disagreement has a durable,
   * commentable home (others can reply with NOTE/ALTERNATIVE_READING) even for a lawyer who
   * never opens a general annotation UI. Best-effort: a failure here doesn't undo the dispute
   * itself, which is the state that actually matters.
   */
  static async dispute(caseId: string, id: string, userId: string, note?: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DecisionRecordRepo.updateStatus(id, caseId, "DISPUTED", note ?? null);
    if (!row) throw new HttpError("Decision record not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "decision.dispute", payload: { id } });
    await AnnotationRepo.create(caseId, {
      authorUserId: userId,
      targetType: "DECISION",
      targetId: id,
      kind: "DISPUTE",
      body: note ?? "Disputed, no note given.",
    }).catch(() => {});
    return row;
  }

  static async reactivate(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await DecisionRecordRepo.updateStatus(id, caseId, "ACTIVE");
    if (!row) throw new HttpError("Decision record not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "decision.reactivate", payload: { id } });
    return row;
  }

  /**
   * Persists one DecisionRecord row per audited record from this turn, and registers each as
   * a DECISION CaseGraphNode with SUPPORTS/CONTRADICTS CaseEdges to the DOCUMENT nodes its
   * verified evidence references — so decisions surface in the Mind Map and citation-map
   * panels with no dedicated UI wiring of its own. Decisions accumulate across the life of
   * the case (no de-duplication in v1): a case sees one row per conclusion per legal turn,
   * which is the raw material a future workstream can de-dup/merge on top of.
   */
  static async promote(caseId: string, sourceMessageId: string, records: DecisionRecordItem[]) {
    if (!caseId || !records.length) return { count: 0 };

    let count = 0;
    for (const record of records) {
      const row = await DecisionRecordRepo.create(caseId, {
        sourceMessageId,
        anchor: record.anchor,
        payload: record as unknown as Prisma.InputJsonValue,
        authorUserId: null,
      });
      count += 1;

      const decisionNode = await CaseGraphSvc.ensureNode(caseId, "DECISION", row.id);
      const linked = new Set<string>();
      const linkEvidence = async (items: DecisionRecordItem["evidenceFor"], relationType: "SUPPORTS" | "CONTRADICTS") => {
        for (const item of items) {
          if (!item.docId) continue; // unverified reference — nothing real to link to
          const dedupeKey = `${item.docId}:${relationType}`;
          if (linked.has(dedupeKey)) continue;
          linked.add(dedupeKey);
          const documentNode = await CaseGraphSvc.ensureNode(caseId, "DOCUMENT", item.docId);
          await CaseEdgeRepo.create(caseId, {
            sourceEntityId: decisionNode.id,
            targetEntityId: documentNode.id,
            relationType,
            metadata: { pinpoint: item.pinpoint, quote: item.quote, decisionAnchor: record.anchor },
          }).catch(() => {}); // unique-constraint races (concurrent promotions) are a no-op, not an error
        }
      };
      await linkEvidence(record.evidenceFor, "SUPPORTS");
      await linkEvidence(record.evidenceAgainst, "CONTRADICTS");
    }
    return { count };
  }
}
