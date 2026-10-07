import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import ChatRepo from "../repositories/chat.repository";
import DocumentChunkSvc from "./document-chunk.service";
import CaseMindMapSvc from "./case-mind-map.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import AudioOverviewQueue from "../queues/audio-overview.queue";
import { audioOverviewView } from "./audio-overview-history.service";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { voicePairForCase } from "../utils/audio-overview-voices";
import { checkAudioOverviewTurns, isAudioOverviewJevEnabled } from "../utils/audio-overview-jev";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/** What the case analysis asks Chat Wonder for. The same words as the app's AUTO_AUDIO_OVERVIEW_PROMPT
 * (lib/chat/auto-prompts.ts): Chat Wonder writes a two-host script whenever a turn mentions an
 * "audio overview", so the server can ask for one with no chat message behind it. */
export const AUDIO_OVERVIEW_PROMPT = "Please generate an audio overview discussing this case.";

/**
 * The case's Audio Overview as the case analysis keeps it: a case-owned MessageAudioOverview row
 * (no chat message), written in the analysis's last wave and then recorded by AudioOverviewQueue.
 * Overviews asked for in chat or Studio still live on their message (ChatSvc); the Terminal pane
 * shows whichever is newest (latest).
 */
export default class AudioOverviewSvc {
  /** The analysis refresh's Audio Overview step (CaseRefreshSvc, wave 3), under the same
   * "audioOverviewScript" lock a chat request holds, so a lawyer's own request already running is
   * a 409 and the step is skipped. A case with no findings yet is skipped quietly. The recording
   * is queued, not awaited: the refresh ends while Polly records, and the pane shows that. */
  static async generateForCase(caseId: string, userId: string): Promise<{ skipped: boolean; id?: string }> {
    if ((await CaseFindingRepo.list(caseId)).length === 0) return { skipped: true };
    const id = await AiGenerationLockSvc.run(caseId, "audioOverviewScript", () => AudioOverviewSvc.writeScript(caseId, userId));
    if (!id) return { skipped: true };
    await AudioOverviewSvc.startRecording(id);
    return { skipped: false, id };
  }

  /** The case's newest overview, from either owner, or null when it has none. */
  static async latest(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const row = await ChatRepo.findLatestAudioOverviewForCase(caseId);
    return row ? audioOverviewView(row) : null;
  }

  /** The Terminal pane's "Retry recording", offered only after a recording failed — the one
   * manual action left on a pane the analysis otherwise owns. */
  static async retryRecording(caseId: string, overviewId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await ChatRepo.findCaseAudioOverview(caseId, overviewId);
    if (!row) throw new HttpError("Audio Overview not found", 404);
    if (row.audioStatus === "IN_PROGRESS") throw new HttpError("This Audio Overview is already being recorded", 409);
    if (row.audioStatus === "COMPLETED") throw new HttpError("This Audio Overview is already recorded", 409);
    await AudioOverviewSvc.startRecording(row.id);
    return { status: "IN_PROGRESS" as const };
  }

  private static async startRecording(id: string): Promise<void> {
    await ChatRepo.updateAudioOverviewAudio(id, { audioStatus: "IN_PROGRESS" });
    AudioOverviewQueue.enqueue(id);
  }

  /** Asks Chat Wonder for the script with the case's ranked document excerpts and its current
   * analysis (findings, timeline, to-dos — CaseMindMapSvc.buildChatContext) as context, so the
   * hosts discuss what this run just wrote. Returns the new row's id, or null when the case has no
   * indexed text to ground on. */
  private static async writeScript(caseId: string, userId: string): Promise<string | null> {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const grounding = await DocumentChunkSvc.relevantChunksForCase(caseId, AUDIO_OVERVIEW_PROMPT);
    if (!grounding.caseDocumentIds.length) return null;

    const [excerpts, analysis, caseLanguage] = await Promise.all([
      DocumentChunkSvc.formatGroundingContext(grounding, 12_000, { caseId }),
      // Best-effort, like chat's map context: without it the script is still written, from the
      // documents alone.
      CaseMindMapSvc.buildChatContext(caseId).catch((err) => {
        logger.warn("Audio Overview: case analysis context unavailable, writing from the documents alone", { err, caseId });
        return "";
      }),
      CaseRepo.findLanguage(caseId),
    ]);
    const documentContext = [excerpts, analysis ? `## CASE ANALYSIS (this case's current findings, timeline and to-dos)\n${analysis}` : ""]
      .filter(Boolean)
      .join("\n\n");

    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("audioOverview", caseId, userId);
    const call = (sessionId: string) =>
      streamChatWonderMessage(
        sessionId,
        AUDIO_OVERVIEW_PROMPT,
        () => {},
        documentContext,
        grounding,
        caseId,
        tenantCode,
        undefined,
        undefined,
        caseLanguage?.language ?? undefined,
        { trace },
      );
    let result: Awaited<ReturnType<typeof streamChatWonderMessage>>;
    try {
      result = await call(await getChatWonderSessionId());
    } catch {
      result = await call(await getChatWonderSessionId());
    }

    const turns = result.audioOverview;
    if (!turns?.length) throw new HttpError("Chat Wonder returned no Audio Overview script", 502);

    const { hostA, hostB } = voicePairForCase(caseId);
    const row = await ChatRepo.saveCaseAudioOverview(caseId, turns, hostA, hostB);
    logger.info("Audio Overview: script written by the case analysis", { caseId, id: row.id, turns: turns.length });

    // Jev's per-turn check, in the background like chat's: nothing waits on it.
    if (isAudioOverviewJevEnabled()) {
      void (async () => {
        const checks = await checkAudioOverviewTurns(turns, await CaseMindMapSvc.jevContext(caseId, userId));
        if (checks.length) await ChatRepo.saveAudioOverviewChecksById(row.id, checks);
      })().catch((err) => logger.warn("Audio Overview: Jev check failed", { err, caseId, id: row.id }));
    }
    return row.id;
  }
}
