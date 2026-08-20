import CaseAccess from "../utils/case-access";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import EvidenceIntelligenceSvc from "./evidence-intelligence.service";
import CaseStrategySvc from "./case-strategy.service";
import CaseTimelineSvc from "./case-timeline.service";
import prisma from "../lib/prisma";
import ChatRepo from "../repositories/chat.repository";
import { TimelineItem } from "../utils/response-parser";
import OrganizationRepo from "../repositories/organization.repository";
import CaseSnapshotSvc from "./case-snapshot.service";
import logger from "../utils/logger";

export default class CaseRefreshSvc {
  static async refresh(caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);

    const docs = await DocumentRepo.listAllByCase(caseId);
    const pending = docs.filter((d) => d.ragStatus === "PENDING" || d.ragStatus === "FAILED");
    if (pending.length) DocumentExtractionQueue.enqueueMany(pending.map((d) => d.id));

    await EvidenceIntelligenceSvc.scanContradictions(caseId, userId).catch(() => []);
    await CaseStrategySvc.generateFromDocuments(caseId, userId).catch((err) => {
      logger.warn("Chat Wonder case strategy failed", { err, caseId });
    });

    const consultations = await prisma.consultation.findMany({
      where: { caseId },
      select: { id: true },
    });
    for (const consultation of consultations) {
      const messages = await ChatRepo.listMessagesByConsultation(consultation.id).catch(() => []);
      const withTimeline = messages.filter((m) => {
        const items = m.timeline?.items;
        return Array.isArray(items) && items.length > 0;
      });
      const latest = withTimeline[withTimeline.length - 1];
      const items = latest?.timeline?.items;
      if (Array.isArray(items) && items.length) {
        await CaseTimelineSvc.promoteFromAi(caseId, items as unknown as TimelineItem[], userId);
      }
    }

    await prisma.case.update({ where: { id: caseId }, data: { lastRefreshedAt: new Date() } });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "case.refresh", payload: { pendingDocs: pending.length } });
    return CaseSnapshotSvc.get(caseId, userId);
  }
}
