import DocumentRepo from "../repositories/document.repository";
import CaseReconstructionAudioQueue from "./case-reconstruction-audio.queue";
import logger from "../utils/logger";

/** Wait until a bulk upload burst stops finishing files, then run case-level AI once. */
const QUIET_MS = 45_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Contradiction scan + case strategy are case-wide. Running them after every READY file
 * would mean 2,000 OpenAI jobs for a 2,000-document dump. Debounce until the extraction
 * queue for that case has gone quiet and no PENDING docs remain.
 */
export function scheduleCasePostExtraction(caseId: string): void {
  const existing = timers.get(caseId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(caseId);
    void runWhenIdle(caseId);
  }, QUIET_MS);
  timers.set(caseId, timer);
}

async function runWhenIdle(caseId: string): Promise<void> {
  try {
    const pending = await DocumentRepo.countPendingExtractionByCase(caseId);
    if (pending > 0) {
      logger.info("Case post-extraction: still pending, waiting", { caseId, pending });
      scheduleCasePostExtraction(caseId);
      return;
    }

    logger.info("Case post-extraction: running after bulk extract", { caseId });
    const EvidenceIntelligenceSvc = (await import("../services/evidence-intelligence.service"))
      .default;
    const CaseStrategySvc = (await import("../services/case-strategy.service")).default;
    const CaseReconstructionSvc = (await import("../services/case-reconstruction.service")).default;
    const CaseReconstructionAudioSvc = (await import("../services/case-reconstruction-audio.service")).default;
    await EvidenceIntelligenceSvc.scanContradictions(caseId).catch((err) => {
      logger.warn("Post-extraction contradiction scan failed", { err, caseId });
    });
    await CaseStrategySvc.generateFromDocuments(caseId).catch((err) => {
      logger.warn("Post-extraction case strategy failed", { err, caseId });
    });
    // Narrative must exist before Polly has anything to narrate — sequential, not
    // Promise.all'd with the two calls above. Polly synthesis itself is async (no completion
    // webhook), so startAudioJob only kicks the job off — CaseReconstructionAudioQueue is what
    // actually polls it to COMPLETED/FAILED without waiting on a viewer to open the case.
    await CaseReconstructionSvc.generate(caseId)
      .then(() => CaseReconstructionAudioSvc.startAudioJob(caseId))
      .then(() => CaseReconstructionAudioQueue.enqueue(caseId))
      .catch((err) => {
        logger.warn("Post-extraction case reconstruction/audio failed", { err, caseId });
      });
  } catch (err) {
    logger.warn("Case post-extraction scheduler failed", { err, caseId });
  }
}
