import DocumentRepo from "../repositories/document.repository";
import CaseRepo from "../repositories/case.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import WitnessExtractSvc from "../services/witness-extract.service";
import DamagesExtractSvc from "../services/damages-extract.service";
import ConsentSvc from "../services/consent.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/** Wait until a bulk upload burst stops finishing files, then run case-level AI once. */
const QUIET_SECONDS = 45;

/**
 * Contradiction scan + case strategy + findings are case-wide. Running them after every READY
 * file would mean 2,000 Chat Wonder jobs for a 2,000-document dump. Debounce until the
 * extraction queue for that case has gone quiet and the READY document set has actually changed
 * since the last refresh.
 *
 * Durable by design: this enqueues a delayed SQS message (AiGenerationQueue, kind
 * "casePostExtraction") instead of holding an in-process setTimeout — a process restart or a
 * second API instance mid-upload no longer silently drops the scheduled fire the way an
 * in-memory timer would. The trade-off: SQS has no way to reset/cancel an in-flight delayed
 * message, so unlike a setTimeout-based debounce, a burst of triggers within the quiet window
 * sends one message per trigger rather than collapsing to one. That's cheap — each early message
 * just finds documents still PENDING or the READY set unchanged and exits quickly (see
 * runCasePostExtraction below) — and it means the eventual real run is attributed to whichever
 * trigger's message happens to be the one that finds pending == 0 and a changed fingerprint, not
 * necessarily the chronologically last caller: a disclosed relaxation of "most recent caller
 * wins" in exchange for surviving restarts/multiple instances.
 *
 * `userId` is the actor to run the eventual refresh as — CaseRefreshSvc's downstream calls
 * (CaseAccess checks inside its sub-services, audit rows) all expect a real user, never a
 * synthetic "system" actor, so every call site threads through whoever actually caused the
 * corpus change (the uploader for an extraction finishing, the deleter for a removed document).
 */
export function scheduleCasePostExtraction(caseId: string, userId: string): void {
  void (async () => {
    try {
      // Dynamic import to avoid a circular top-level import — see ai-generation.queue.ts's
      // RUNNERS comment for the other half of this.
      const AiGenerationQueue = (await import("./ai-generation.queue")).default;
      AiGenerationQueue.enqueue({ kind: "casePostExtraction", caseId, userId }, QUIET_SECONDS);
    } catch (err) {
      logger.error("Case post-extraction: failed to schedule via AiGenerationQueue", { err, caseId, userId });
    }
  })();
}

/** Run by AiGenerationQueue's worker once a "casePostExtraction" message's SQS delay elapses.
 * Always re-reads live state (pending count, READY set, lock status) rather than trusting
 * anything captured at schedule time — required both for the fingerprint/pending-count
 * coalescing described above and so a message that outlived a restart still acts on current
 * reality, not stale state. */
export async function runCasePostExtraction(caseId: string, userId: string): Promise<void> {
  try {
    if (!(await CaseRepo.exists(caseId))) {
      return;
    }

    // This runs without anyone pressing a button, on behalf of whoever uploaded or deleted the
    // document. If they have switched AI processing off, the case is left as it is: no analysis
    // is started (and no lock was taken yet, so nothing is left half-done).
    if (!(await ConsentSvc.isAllowed(userId, "AI_PROCESSING"))) {
      logger.info("Case post-extraction: skipped, AI processing consent is withdrawn", { caseId, userId });
      return;
    }

    const pending = await DocumentRepo.countPendingExtractionByCase(caseId);
    if (pending > 0) {
      scheduleCasePostExtraction(caseId, userId);
      return;
    }

    const docs = await DocumentRepo.listAllByCase(caseId);
    const fingerprint = computeReadySetFingerprint(docs);
    const previousFingerprint = await CaseRepo.getReadySetFingerprint(caseId);
    const readySetChanged = fingerprint !== previousFingerprint;

    if (readySetChanged) {
      // Reuses the exact same pipeline (contradictions + case strategy + case findings + AI
      // timeline->Evidence promotion) the lawyer's "Refresh analysis" button runs — see
      // CaseRefreshSvc.refreshInner — so Legal Issues / Strengths / Weaknesses / Attack /
      // Defense stop sitting stale until someone clicks it. There is deliberately no second,
      // independent implementation of that pipeline here.
      // A pane's own Regenerate is running: wait for it rather than overlap (ADR 0018). Same
      // QUIET_SECONDS backoff as the branches around it, so the corpus change isn't lost.
      if (await AiGenerationLockSvc.runningPaneJob(caseId)) {
        scheduleCasePostExtraction(caseId, userId);
        return;
      }
      try {
        await AiGenerationLockSvc.begin(caseId, "caseRefresh");
      } catch (err) {
        // A manual "Refresh analysis" click (or another pending auto-trigger) is already
        // running this exact job — reschedule rather than dropping the corpus change on the
        // floor, so a change that lands mid-refresh still gets picked up once the current run
        // finishes (same QUIET_SECONDS backoff as the "still pending" branch above, not a tight
        // retry loop). At most one caseRefresh job for this case is ever IN_PROGRESS at a time.
        if (err instanceof HttpError && err.statusCode === 409) {
          scheduleCasePostExtraction(caseId, userId);
          return;
        }
        throw err;
      }

      const CaseRefreshSvc = (await import("../services/case-refresh.service")).default;
      // runQueued closes out the lock (DONE/FAILED) itself via AiGenerationLockSvc.finishWith —
      // same as the controller's queued HTTP path (CaseTerminalCtrl.refresh).
      // refreshInner itself persists the fingerprint on success (see CaseRefreshSvc) — shared
      // with the manual "Refresh analysis" path, so a manual click also counts as "the last
      // successful refresh" for this skip-check, not just an auto-triggered one.
      await CaseRefreshSvc.runQueued(caseId, userId, "post-extraction");
      logger.info("Case refresh completed", { caseId, userId, source: "auto" });
    } else {
      // Witnesses and damages are read inside the refresh (its first wave) so the next wave
      // scores and re-rates all of them. With no refresh this time, their queued jobs still
      // backfill documents never read for them (witnessesExtractedAt / damagesExtractedAt) — a
      // quick no-op when there are none.
      WitnessExtractSvc.schedule(caseId, userId);
      DamagesExtractSvc.schedule(caseId, userId);
      // Archiving/unarchiving a document leaves the case's READY set — and so the rest of the
      // analysis — alone, but the case mind map leaves archived documents out (it follows chat
      // grounding; see mindMapDocumentIds). Bring just the map back in step when its document set
      // moved without the READY set moving — or build it when the case never got a first map.
      const { default: CaseMindMapSvc, isCaseMindMapBusy } = await import("../services/case-mind-map.service");
      if ((await CaseMindMapSvc.documentsChangedSinceBuild(caseId)) || (await CaseMindMapSvc.needsFirstMap(caseId))) {
        try {
          await CaseMindMapSvc.generateFromDocuments(caseId, userId);
        } catch (err) {
          // A map build (a Regenerate, or the refresh's own) is already running — one coalesced
          // map-only retry after it, however many archive/unarchive clicks land meanwhile.
          if (isCaseMindMapBusy(err)) await CaseMindMapSvc.scheduleResync(caseId, userId);
          else logger.warn("Case post-extraction: mind map resync failed", { err, caseId });
        }
      }
    }

    // Case Reconstruction is now a step of the refresh above (CaseReconstructionSvc.autoRegenerate),
    // so a changed READY set already (re)generated it. This catches the one case the refresh
    // skips: an unchanged READY set on a case that still has no narrative — e.g. an earlier
    // attempt at its first one failed. A cheap existence read, checked regardless of readySetChanged.
    const existingReconstruction = await CaseReconstructionRepo.get(caseId);
    if (!existingReconstruction) {
      const CaseReconstructionSvc = (await import("../services/case-reconstruction.service")).default;
      await CaseReconstructionSvc.autoRegenerate(caseId, userId).catch((err) => {
        logger.warn("Post-extraction case reconstruction failed", { err, caseId, userId });
      });
    }
  } catch (err) {
    logger.error("Case refresh failed", { err, caseId, userId, source: "auto" });
  }
}
