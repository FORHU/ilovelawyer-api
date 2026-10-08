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
import CaseChangeRun from "./case-change-run.service";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseOutlookRepo from "../repositories/case-outlook.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import RedTeamRepo from "../repositories/red-team.repository";
import CaseChangeReads from "./case-change-reads";
import {
    audioOverviewDelta,
    diffDamages,
    diffFindings,
    diffMindMap,
    diffOutlook,
    diffReconstruction,
    diffRedTeam,
    diffStrategy,
    diffTheory,
    diffWitnesses,
} from "../utils/case-change-delta";
import MissingEvidenceAiSvc from "./missing-evidence-ai.service";
import HttpError from "../utils/http-error";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import logger from "../utils/logger";

/** The "caseRefresh" job's stage (AiGenerationJob.stage) as each wave after the first starts —
 * null during wave 1. The app reads it to stop showing a piece as updating once the wave that
 * writes it is over: the timeline's dates (case strategy) in wave 1, the case map in wave 2,
 * rather than for the whole run. Mirrored in ilovelawyer-app's lib/terminal/case-refresh-stage.ts. */
export const CASE_REFRESH_STAGE = { wave2: "wave2", wave3: "wave3" } as const;

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
     * `reason` distinguishes a lawyer's "Refresh analysis" click from the automatic
     * post-extraction trigger (case-post-extraction.ts passes "post-extraction" explicitly): in the
     * case.refresh audit row, the map's build reason, and whether damages re-reads every document. */
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

        // What each tracked pane said before its step and after it, saved as one CaseChangeSummary
        // at the end — the Legal Terminal's "What changed" modal reads it.
        const changes = new CaseChangeRun(caseId);

        // The steps run in three waves. Within a wave every step runs at the same time; a wave
        // starts once the one before it has settled, because its steps read what that wave wrote.
        // Each step holds its own lock and runs through runStep, so one that fails — or is skipped
        // because the same piece's own job already holds its lock — never stops the others.

        // Witnesses and damages are each written by two steps (read new documents in wave 1, score or
        // re-rate in wave 2), so they are read before wave 1 and compared after wave 2.
        await Promise.all([
            changes.capture("witnesses", () => CaseChangeReads.witnesses(caseId)),
            changes.capture("damages", () => CaseChangeReads.damages(caseId)),
        ]);

        // Wave 1: everything that reads only the documents.
        await CaseRefreshSvc.runWave(caseId, 1, [
            [
                "contradictions scan",
                () =>
                    changes.track("contradictions", async () => {
                        const { rows, delta } = await EvidenceIntelligenceSvc.scanContradictions(caseId, userId);
                        changes.record("contradictions", delta);
                        return { found: rows.length, added: delta.addedCount, dropped: delta.droppedCount };
                    }),
            ],
            // Plan, to-dos and the timeline's document dates.
            [
                "case strategy",
                () =>
                    changes.compare(
                        "strategy",
                        () => CaseChangeReads.strategy(caseId),
                        async () => (await CaseStrategySvc.generateFromDocuments(caseId, userId), {}),
                        (before, after) => diffStrategy(before, after),
                    ),
            ],
            [
                "case findings",
                () =>
                    changes.compare(
                        "findings",
                        () => CaseFindingRepo.list(caseId),
                        async () => (await CaseFindingAiSvc.generateFromDocuments(caseId, userId), {}),
                        (before, after) => diffFindings(before, after),
                    ),
            ],
            // Inline, batch after batch, so the next wave scores and re-rates every new entry.
            ["witness extraction", () => changes.track("witnesses", () => WitnessExtractSvc.extractAllPending(caseId, userId))],
            // A lawyer's click reads every document again; the automatic run reads only new ones.
            [
                "damages extraction",
                () => changes.track("damages", () => DamagesExtractSvc.extractAllPending(caseId, userId, { rereadAll: reason === "manual" })),
            ],
            // The narrative reads the documents alone; it is rewritten only while nobody has edited it.
            [
                "case reconstruction",
                () =>
                    changes.compare(
                        "reconstruction",
                        () => CaseReconstructionRepo.get(caseId),
                        async () => ({ outcome: await CaseReconstructionSvc.autoRegenerate(caseId, userId) }),
                        (before, after, { outcome }) => diffReconstruction(before, after, outcome),
                    ),
            ],
            // Case Reconstruction's event chain reads the documents alone, not the narrative.
            [
                "reconstruction events",
                async () => ({ events: (await CaseReconstructionSvc.generateEvents(caseId, userId))?.events.length ?? 0 }),
            ],
            // Reads the documents and the case's claims; claims are lawyer- or ClaimExtract-authored,
            // never written by this refresh, so there is nothing earlier in the run to wait for.
            ["missing evidence", async () => ({ found: (await MissingEvidenceAiSvc.generateFromDocuments(caseId, userId)).length })],
        ]);

        // Wave 2: what reads the findings, strategy, contradictions, witnesses and damages above.
        void AiGenerationLockSvc.setStage(caseId, "caseRefresh", CASE_REFRESH_STAGE.wave2);
        await CaseRefreshSvc.runWave(caseId, 2, [
            // Case Reconstruction's scenes (and the Storyboard built on them) read the timeline's
            // dates and need the narrative, both written in wave 1.
            ["reconstruction scenes", () => CaseReconstructionSvc.autoGenerateScenes(caseId, userId)],
            // The outlook prompt reads the findings.
            [
                "case outlook",
                () =>
                    changes.compare(
                        "outlook",
                        () => CaseOutlookRepo.latest(caseId),
                        async () => (await CaseOutlookAiSvc.generateFromDocuments(caseId, userId), {}),
                        (before, after) => diffOutlook(before, after),
                    ),
            ],
            // Jev's awardability reads the findings; every head (old and just extracted) is re-rated.
            ["damages re-rating", () => changes.track("damages", () => DamagesExtractSvc.refreshStep(caseId))],
            // Scoring reads the witnesses, contradictions, evidence and timeline dates.
            ["witness scoring", () => changes.track("witnesses", () => WitnessScoringSvc.scoreFromDocuments(caseId, userId))],
            [
                "theory draft",
                () =>
                    changes.compare(
                        "theory",
                        () => CaseChangeReads.theory(caseId),
                        () => CaseTheorySvc.refreshAiDraft(caseId, userId),
                        // No findings yet to build a theory from: the step didn't run.
                        (before, after, { skipped }) => (skipped ? { status: "skipped" as const } : diffTheory(before, after)),
                    ),
            ],
            // The map prompt reads the key dates, findings and to-dos. The automatic run skips
            // itself when the documents haven't changed; "Refresh analysis" rebuilds anyway. Neither
            // overwrites a map someone has expanded — see CaseMindMapSvc. Another build already
            // running (a Regenerate) may have read the documents before this change, so a busy lock
            // queues one coalesced retry rather than losing it (CaseMindMapSvc.scheduleResync).
            [
                "case mind map",
                () =>
                    changes.compare(
                        "mindMap",
                        () => CaseChangeReads.mindMap(caseId),
                        async (): Promise<{ skipped?: string | null; resyncQueued?: boolean }> => {
                            try {
                                const result = await CaseMindMapSvc.generateFromDocuments(caseId, userId, reason === "manual" ? "refresh" : "auto");
                                return { skipped: result.skipped };
                            } catch (err) {
                                if (!isCaseMindMapBusy(err)) throw err;
                                await CaseMindMapSvc.scheduleResync(caseId, userId);
                                return { resyncQueued: true };
                            }
                        },
                        (before, after, result) =>
                            result.resyncQueued ? { status: "skipped" as const } : diffMindMap(before, after, result.skipped === "userChanges"),
                    ),
            ],
        ]);
        await Promise.all([
            changes.settle("witnesses", () => CaseChangeReads.witnesses(caseId), diffWitnesses),
            changes.settle("damages", () => CaseChangeReads.damages(caseId), diffDamages),
        ]);

        // Wave 3: what reads everything above — findings, contradictions, witnesses and the re-rated
        // damages. Red Team attacks them; the Audio Overview's two hosts discuss them (the script is
        // written here, and its recording queued, not awaited — the run ends while Polly records).
        void AiGenerationLockSvc.setStage(caseId, "caseRefresh", CASE_REFRESH_STAGE.wave3);
        await CaseRefreshSvc.runWave(caseId, 3, [
            [
                "red team",
                () =>
                    changes.compare(
                        "redTeam",
                        () => RedTeamRepo.get(caseId),
                        () => RedTeamSvc.generateFromDocuments(caseId, userId),
                        // Nothing to attack yet (no findings, no contradictions): the step didn't run.
                        (before, after, { skipped }) => (skipped ? { status: "skipped" as const } : diffRedTeam(before, after)),
                    ),
            ],
            [
                "audio overview",
                () =>
                    changes.track("audioOverview", async () => {
                        const result = await AudioOverviewSvc.generateForCase(caseId, userId);
                        changes.record("audioOverview", audioOverviewDelta(result.skipped ? null : result.id));
                        return result;
                    }),
            ],
        ]);

        // Chat dates no longer go on the case timeline (they carry no document); clear the ones
        // earlier versions copied in. A failure never fails the refresh.
        await CaseTimelineSvc.removeChatCopiedEvents(caseId)
            .then((removed) => {
                if (removed) logger.info("Refresh analysis: removed chat-copied timeline events", { caseId, removed });
            })
            .catch((err) => logger.warn("Refresh analysis: chat-copied timeline cleanup failed", { err, caseId }));

        const summary = await changes.save({ reason, actorId: userId, documents: docs });

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
            payload: {
                pendingDocs: pending.length,
                reason,
                ...(summary ? { changeSummaryId: summary.id, totalChanges: summary.totalChanges } : {}),
            },
        });
        logger.info("Refresh analysis: completed", { caseId, userId, reason });
        return CaseSnapshotSvc.get(caseId, userId);
    }
}
