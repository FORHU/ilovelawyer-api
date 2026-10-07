import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import EvidenceIntelligenceSvc from "./evidence-intelligence.service";
import CaseStrategySvc from "./case-strategy.service";
import CaseFindingAiSvc from "./case-finding-ai.service";
import CaseOutlookAiSvc from "./case-outlook-ai.service";
import CaseMindMapSvc, { isCaseMindMapBusy } from "./case-mind-map.service";
import CaseTimelineSvc from "./case-timeline.service";
import DamagesExtractSvc from "./damages-extract.service";
import OrganizationRepo from "../repositories/organization.repository";
import CaseSnapshotSvc from "./case-snapshot.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import RedTeamSvc from "./red-team.service";
import AudioOverviewSvc from "./audio-overview.service";
import WitnessExtractSvc from "./witness-extract.service";
import WitnessScoringSvc from "./witness-scoring.service";
import CaseTheorySvc from "./case-theory.service";
import CaseReconstructionSvc from "./case-reconstruction.service";
import HttpError from "../utils/http-error";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import logger from "../utils/logger";

export default class CaseRefreshSvc {
    /** Fast, synchronous half of a queued refresh — access check + claiming the
     * AiGenerationJob row — called from the controller before handing off to
     * AiGenerationQueue, so a 403/409 surfaces immediately instead of after an enqueue. */
    static async beginQueued(caseId: string, userId: string): Promise<void> {
        await CaseAccess.assertCanEdit(caseId, userId);
        // A pane's own Regenerate and the analysis never overlap (ADR 0018).
        await AiGenerationLockSvc.assertNoPaneRunning(caseId);
        // Own outer lock, purely to stop a double-click on "Refresh analysis" itself — the
        // sub-calls below each hold their own lock too (contradictions/caseStrategy/caseFinding),
        // so a 409 from one of those (e.g. Contradictions already running standalone) is caught by
        // the existing .catch() blocks below and just skips that piece, same as any other failure.
        await AiGenerationLockSvc.begin(caseId, "caseRefresh");
    }

    /** Run by AiGenerationQueue's worker after beginQueued has already claimed the job row.
     * `reason` is audit-trail only — it never changes what runs, just distinguishes a lawyer's
     * "Refresh analysis" click from the automatic post-extraction trigger in the case.refresh
     * audit row (case-post-extraction.ts passes "post-extraction" explicitly). */
    static async runQueued(caseId: string, userId: string, reason: "manual" | "post-extraction" = "manual"): Promise<void> {
        await AiGenerationLockSvc.finishWith(caseId, "caseRefresh", () =>
            CaseRefreshSvc.refreshInner(caseId, userId, reason),
        );
    }

    /** Runs a wave's steps side by side and waits for all of them. Never throws. */
    private static async runWave(caseId: string, wave: number, steps: [string, () => Promise<object>][]): Promise<void> {
        const startedAt = Date.now();
        await Promise.all(steps.map(([name, fn]) => CaseRefreshSvc.runStep(caseId, name, fn)));
        logger.info(`Refresh analysis: wave ${wave} done`, { caseId, steps: steps.length, durationMs: Date.now() - startedAt });
    }

    /** One step of the refresh: logs how it went, treats a 409 (the same piece's own job is
     * already running) as a skip, and swallows any other failure. */
    private static async runStep(caseId: string, name: string, fn: () => Promise<object>): Promise<void> {
        const startedAt = Date.now();
        try {
            const result = await fn();
            logger.info(`Refresh analysis: ${name} done`, { caseId, ...result, durationMs: Date.now() - startedAt });
        } catch (err) {
            if (err instanceof HttpError && err.statusCode === 409) {
                logger.info(`Refresh analysis: ${name} already running, skipped`, { caseId });
                return;
            }
            logger.warn(`Refresh analysis: ${name} failed`, { err, caseId, durationMs: Date.now() - startedAt });
        }
    }

    private static async refreshInner(caseId: string, userId: string, reason: "manual" | "post-extraction") {
        logger.info("Refresh analysis: started", { caseId, userId, reason });

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

        // The steps run in three waves. Within a wave every step runs at the same time; a wave
        // starts once the one before it has settled, because its steps read what that wave wrote.
        // Each step holds its own lock and runs through runStep, so one that fails — or is skipped
        // because the same piece's own job already holds its lock — never stops the others.

        // Wave 1: everything that reads only the documents.
        await CaseRefreshSvc.runWave(caseId, 1, [
            ["contradictions scan", async () => ({ found: (await EvidenceIntelligenceSvc.scanContradictions(caseId, userId))?.length })],
            // Plan, to-dos and the timeline's document dates.
            ["case strategy", async () => (await CaseStrategySvc.generateFromDocuments(caseId, userId), {})],
            ["case findings", async () => (await CaseFindingAiSvc.generateFromDocuments(caseId, userId), {})],
            // Inline, batch after batch, so the next wave scores and re-rates every new entry.
            ["witness extraction", () => WitnessExtractSvc.extractAllPending(caseId, userId)],
            ["damages extraction", () => DamagesExtractSvc.extractAllPending(caseId, userId)],
            // The narrative reads the documents alone; it is rewritten only while nobody has edited it.
            ["case reconstruction", async () => ({ outcome: await CaseReconstructionSvc.autoRegenerate(caseId, userId) })],
        ]);

        // Wave 2: what reads the findings, strategy, contradictions, witnesses and damages above.
        await CaseRefreshSvc.runWave(caseId, 2, [
            // The outlook prompt reads the findings.
            ["case outlook", async () => (await CaseOutlookAiSvc.generateFromDocuments(caseId, userId), {})],
            // Jev's awardability reads the findings; every head (old and just extracted) is re-rated.
            ["damages re-rating", () => DamagesExtractSvc.refreshStep(caseId)],
            // Scoring reads the witnesses, contradictions, evidence and timeline dates.
            ["witness scoring", () => WitnessScoringSvc.scoreFromDocuments(caseId, userId)],
            ["theory draft", () => CaseTheorySvc.refreshAiDraft(caseId, userId)],
            // The map prompt reads the key dates, findings and to-dos. The automatic run skips
            // itself when the documents haven't changed; "Refresh analysis" rebuilds anyway. Neither
            // overwrites a map someone has expanded — see CaseMindMapSvc. Another build already
            // running (a Regenerate) may have read the documents before this change, so a busy lock
            // queues one coalesced retry rather than losing it (CaseMindMapSvc.scheduleResync).
            [
                "case mind map",
                async () => {
                    try {
                        const result = await CaseMindMapSvc.generateFromDocuments(caseId, userId, reason === "manual" ? "refresh" : "auto");
                        return { skipped: result.skipped };
                    } catch (err) {
                        if (!isCaseMindMapBusy(err)) throw err;
                        await CaseMindMapSvc.scheduleResync(caseId, userId);
                        return { resyncQueued: true };
                    }
                },
            ],
        ]);

        // Wave 3: what reads everything above — findings, contradictions, witnesses and the re-rated
        // damages. Red Team attacks them; the Audio Overview's two hosts discuss them (the script is
        // written here, and its recording queued, not awaited — the run ends while Polly records).
        await CaseRefreshSvc.runWave(caseId, 3, [
            ["red team", () => RedTeamSvc.generateFromDocuments(caseId, userId)],
            ["audio overview", () => AudioOverviewSvc.generateForCase(caseId, userId)],
        ]);

        // Chat dates no longer go on the case timeline (they carry no document); clear the ones
        // earlier versions copied in. A failure never fails the refresh.
        await CaseTimelineSvc.removeChatCopiedEvents(caseId)
            .then((removed) => {
                if (removed) logger.info("Refresh analysis: removed chat-copied timeline events", { caseId, removed });
            })
            .catch((err) => logger.warn("Refresh analysis: chat-copied timeline cleanup failed", { err, caseId }));

        await CaseRepo.markRefreshed(caseId);
        // Persisted here (not only in the automatic post-extraction path) so a manual "Refresh
        // analysis" click also counts as "the last successful refresh" for the fingerprint skip —
        // otherwise an auto-trigger for the same still-unchanged READY set right after a manual
        // click would see a stale/missing fingerprint and burn every Chat Wonder call again.
        await CaseRepo.setReadySetFingerprint(caseId, computeReadySetFingerprint(docs));
        await OrganizationRepo.writeAudit({
            caseId,
            actorId: userId,
            action: "case.refresh",
            payload: { pendingDocs: pending.length, reason },
        });
        logger.info("Refresh analysis: completed", { caseId, userId, reason });
        return CaseSnapshotSvc.get(caseId, userId);
    }
}
