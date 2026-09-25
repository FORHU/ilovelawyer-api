import DocumentRepo from "../repositories/document.repository";
import CaseRepo from "../repositories/case.repository";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import CaseReconstructionAudioQueue from "./case-reconstruction-audio.queue";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import { computeReadySetFingerprint } from "../utils/ready-set-fingerprint";
import WitnessExtractSvc from "../services/witness-extract.service";
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
      logger.info("Case refresh scheduled", { caseId, userId, source: "auto", delaySeconds: QUIET_SECONDS });
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
      logger.info("Case post-extraction: case no longer exists, skipping", { caseId });
      return;
    }

    const pending = await DocumentRepo.countPendingExtractionByCase(caseId);
    if (pending > 0) {
      logger.info("Case post-extraction: still pending, waiting", { caseId, userId, pending });
      scheduleCasePostExtraction(caseId, userId);
      return;
    }

    // Its own queued job with its own lock, so it runs alongside the refresh below rather than
    // after it. Scheduled regardless of readySetChanged: it only ever reads documents it hasn't
    // read yet (Document.witnessesExtractedAt), so an unchanged corpus is a quick no-op, and a
    // case whose documents predate this job gets backfilled on its next trigger.
    WitnessExtractSvc.schedule(caseId, userId);

    const docs = await DocumentRepo.listAllByCase(caseId);
    const fingerprint = computeReadySetFingerprint(docs);
    const previousFingerprint = await CaseRepo.getReadySetFingerprint(caseId);
    const readySetChanged = fingerprint !== previousFingerprint;

    if (!readySetChanged) {
      logger.info("Case refresh skipped: READY set unchanged", { caseId, userId, source: "auto" });
    } else {
      // Reuses the exact same pipeline (contradictions + case strategy + case findings + AI
      // timeline->Evidence promotion) the lawyer's "Refresh analysis" button runs — see
      // CaseRefreshSvc.refreshInner — so Legal Issues / Strengths / Weaknesses / Attack /
      // Defense stop sitting stale until someone clicks it. There is deliberately no second,
      // independent implementation of that pipeline here.
      try {
        await AiGenerationLockSvc.begin(caseId, "caseRefresh");
      } catch (err) {
        // A manual "Refresh analysis" click (or another pending auto-trigger) is already
        // running this exact job — reschedule rather than dropping the corpus change on the
        // floor, so a change that lands mid-refresh still gets picked up once the current run
        // finishes (same QUIET_SECONDS backoff as the "still pending" branch above, not a tight
        // retry loop). At most one caseRefresh job for this case is ever IN_PROGRESS at a time.
        if (err instanceof HttpError && err.statusCode === 409) {
          logger.info("Case refresh coalesced: caseRefresh already in progress, rescheduling", {
            caseId,
            userId,
            source: "auto",
          });
          scheduleCasePostExtraction(caseId, userId);
          return;
        }
        throw err;
      }

      logger.info("Case refresh job claimed", { caseId, userId, source: "auto" });
      const CaseRefreshSvc = (await import("../services/case-refresh.service")).default;
      // runQueued closes out the lock (DONE/FAILED) itself via AiGenerationLockSvc.finishWith —
      // same as the controller's queued HTTP path (CaseTerminalCtrl.refresh).
      // refreshInner itself persists the fingerprint on success (see CaseRefreshSvc) — shared
      // with the manual "Refresh analysis" path, so a manual click also counts as "the last
      // successful refresh" for this skip-check, not just an auto-triggered one.
      await CaseRefreshSvc.runQueued(caseId, userId, "post-extraction");
      logger.info("Case refresh completed", { caseId, userId, source: "auto" });
    }

    // Narrative generation is a separate, heavier single-shot call — only auto-run it the first
    // time a case gets an indexed corpus. Once a narrative exists, later corpus changes only
    // refresh findings/strategy/contradictions above, never silently rewriting a narrative that
    // may already include the lawyer's own edits (see CaseReconstructionSvc.update). Checked
    // regardless of readySetChanged — a cheap existence read, and it also covers a case where an
    // earlier attempt at this step failed (see catch below) even though the corpus hasn't
    // changed since that attempt.
    const existingReconstruction = await CaseReconstructionRepo.get(caseId);
    if (!existingReconstruction) {
      const CaseReconstructionSvc = (await import("../services/case-reconstruction.service")).default;
      const CaseReconstructionAudioSvc = (await import("../services/case-reconstruction-audio.service")).default;
      // Narrative must exist before Polly has anything to narrate — sequential, not
      // Promise.all'd with the refresh above. Polly synthesis itself is async (no completion
      // webhook), so startAudioJob only kicks the job off — CaseReconstructionAudioQueue is
      // what actually polls it to COMPLETED/FAILED without waiting on a viewer to open the case.
      await CaseReconstructionSvc.generate(caseId, userId)
        .then(() => CaseReconstructionAudioSvc.startAudioJob(caseId))
        .then(() => CaseReconstructionAudioQueue.enqueue(caseId))
        .catch((err) => {
          logger.warn("Post-extraction case reconstruction/audio failed", { err, caseId, userId });
        });
    }
  } catch (err) {
    logger.error("Case refresh failed", { err, caseId, userId, source: "auto" });
  }
}
