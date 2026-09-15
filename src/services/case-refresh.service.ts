import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import EvidenceIntelligenceSvc from "./evidence-intelligence.service";
import CaseStrategySvc from "./case-strategy.service";
import CaseFindingAiSvc from "./case-finding-ai.service";
import CaseTimelineSvc from "./case-timeline.service";
import ChatRepo from "../repositories/chat.repository";
import { TimelineItem } from "../utils/response-parser";
import OrganizationRepo from "../repositories/organization.repository";
import CaseSnapshotSvc from "./case-snapshot.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import logger from "../utils/logger";

export default class CaseRefreshSvc {
    /** Fast, synchronous half of a queued refresh — access check + claiming the
     * AiGenerationJob row — called from the controller before handing off to
     * AiGenerationQueue, so a 403/409 surfaces immediately instead of after an enqueue. */
    static async beginQueued(caseId: string, userId: string): Promise<void> {
        await CaseAccess.assertCanEdit(caseId, userId);
        // Own outer lock, purely to stop a double-click on "Refresh analysis" itself — the
        // sub-calls below each hold their own lock too (contradictions/caseStrategy/caseFinding),
        // so a 409 from one of those (e.g. Contradictions already running standalone) is caught by
        // the existing .catch() blocks below and just skips that piece, same as any other failure.
        await AiGenerationLockSvc.begin(caseId, "caseRefresh");
    }

    /** Run by AiGenerationQueue's worker after beginQueued has already claimed the job row. */
    static async runQueued(caseId: string, userId: string): Promise<void> {
        await AiGenerationLockSvc.finishWith(caseId, "caseRefresh", () =>
            CaseRefreshSvc.refreshInner(caseId, userId),
        );
    }

    private static async refreshInner(caseId: string, userId: string) {
        logger.info("Refresh analysis: started", { caseId, userId });

        // The automatic post-extraction trigger schedules this up to 45s (plus queue wait) after
        // the corpus change that caused it — long enough for the case to have been deleted in
        // the meantime. Manual "Refresh analysis" clicks can't hit this (beginQueued's
        // CaseAccess.assertCanEdit already confirmed the case exists just before enqueueing).
        if (!(await CaseRepo.exists(caseId))) {
            logger.info("Refresh analysis: case no longer exists, skipping", { caseId });
            return;
        }

        const docs = await DocumentRepo.listAllByCase(caseId);
        const pending = docs.filter(
            (d) => d.ragStatus === "PENDING" || d.ragStatus === "FAILED",
        );
        if (pending.length) {
            logger.info("Refresh analysis: re-queuing pending documents", { caseId, count: pending.length });
            DocumentExtractionQueue.enqueueMany(pending.map((d) => d.id));
        }

        let stepStartedAt = Date.now();
        await EvidenceIntelligenceSvc.scanContradictions(caseId, userId)
            .then(() => {
                logger.info("Refresh analysis: contradictions scan done", { caseId, durationMs: Date.now() - stepStartedAt });
            })
            .catch((err) => {
                logger.warn("Chat Wonder contradictions scan failed", {
                    err,
                    caseId,
                    durationMs: Date.now() - stepStartedAt,
                });
                return [];
            });

        stepStartedAt = Date.now();
        await CaseStrategySvc.generateFromDocuments(caseId, userId)
            .then(() => {
                logger.info("Refresh analysis: case strategy done", { caseId, durationMs: Date.now() - stepStartedAt });
            })
            .catch((err) => {
                logger.warn("Chat Wonder case strategy failed", {
                    err,
                    caseId,
                    durationMs: Date.now() - stepStartedAt,
                });
            });

        stepStartedAt = Date.now();
        await CaseFindingAiSvc.generateFromDocuments(caseId, userId)
            .then(() => {
                logger.info("Refresh analysis: case finding done", { caseId, durationMs: Date.now() - stepStartedAt });
            })
            .catch((err) => {
                logger.warn("Chat Wonder case finding generation failed", {
                    err,
                    caseId,
                    durationMs: Date.now() - stepStartedAt,
                });
            });

        const consultations = await ChatRepo.listConsultationIdsByCase(caseId);
        for (const consultation of consultations) {
            const messages = await ChatRepo.listMessagesByConsultation(
                consultation.id,
            ).catch(() => []);
            const withTimeline = messages.filter((m) => {
                const items = m.timeline?.items;
                return Array.isArray(items) && items.length > 0;
            });
            const latest = withTimeline[withTimeline.length - 1];
            const items = latest?.timeline?.items;
            if (Array.isArray(items) && items.length) {
                await CaseTimelineSvc.promoteFromAi(
                    caseId,
                    items as unknown as TimelineItem[],
                    userId,
                );
                logger.info("Refresh analysis: promoted AI timeline", { caseId, consultationId: consultation.id });
            }
        }

        await CaseRepo.markRefreshed(caseId);
        await OrganizationRepo.writeAudit({
            caseId,
            actorId: userId,
            action: "case.refresh",
            payload: { pendingDocs: pending.length },
        });
        logger.info("Refresh analysis: completed", { caseId, userId });
        return CaseSnapshotSvc.get(caseId, userId);
    }
}
