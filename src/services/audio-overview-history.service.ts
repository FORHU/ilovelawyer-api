import CaseAccess from "../utils/case-access";
import ChatRepo from "../repositories/chat.repository";
import { getProxyFileUrl } from "../utils/s3";
import { audioOverviewFilename } from "../utils/audio-overview-filename";
import type { AudioOverviewTurn } from "../utils/response-parser";
import type { AudioOverviewTurnCheck } from "../utils/audio-overview-jev";
import type { MarkTiming } from "../utils/audio-overview-render";

type AudioOverviewRow = NonNullable<Awaited<ReturnType<typeof ChatRepo.findLatestAudioOverviewForCase>>>;

/** One overview as the panes read it, from either owner. `source` says who made it: the case
 * analysis ("analysis", no consultation behind it) or a lawyer's chat/Studio request ("chat"). */
export function audioOverviewView(row: AudioOverviewRow) {
  return {
    id: row.id,
    messageId: row.messageId,
    consultationId: row.message?.consultationId ?? null,
    source: row.caseId ? ("analysis" as const) : ("chat" as const),
    createdAt: row.createdAt,
    status: row.audioStatus,
    turns: row.turns as unknown as AudioOverviewTurn[],
    checks: (row.checks as unknown as AudioOverviewTurnCheck[] | null) ?? [],
    turnTimings: (row.turnTimings as unknown as number[] | null) ?? null,
    sentenceTimings: (row.sentenceTimings as unknown as MarkTiming[][] | null) ?? null,
    wordTimings: (row.wordTimings as unknown as MarkTiming[][] | null) ?? null,
    audio: row.audioFile?.s3Key ? { id: row.audioFile.id, fileUrl: getProxyFileUrl(row.audioFile.s3Key, { filename: audioOverviewFilename(row.createdAt) }) } : null,
  };
}

export default class AudioOverviewHistorySvc {
  /** Every Audio Overview generated for the case (by the case analysis or in its consultations), newest first — the counterpart of
   * CaseBriefExportSvc.listHistory, with the same read-level access check and cursor
   * convention (nextCursor present only when a full page came back). Includes the script and
   * Jev's checks so a past overview can be re-read, and a fresh proxy URL for the audio when it
   * has been rendered (`audio` is null until then). */
  static async list(caseId: string, userId: string, filters: { limit?: number; cursor?: string } = {}) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const rows = await ChatRepo.listAudioOverviewsByCase(caseId, filters);
    const items = rows.map(audioOverviewView);
    const nextCursor = filters.limit && items.length === filters.limit ? items[items.length - 1]!.id : null;
    return { items, nextCursor };
  }
}
