import CaseAccess from "../utils/case-access";
import ChatRepo from "../repositories/chat.repository";
import { getProxyFileUrl } from "../utils/s3";
import { audioOverviewFilename } from "../utils/audio-overview-filename";
import type { AudioOverviewTurn } from "../utils/response-parser";
import type { AudioOverviewTurnCheck } from "../utils/audio-overview-jev";

export default class AudioOverviewHistorySvc {
  /** Every Audio Overview generated for the case, newest first — the counterpart of
   * CaseBriefExportSvc.listHistory, with the same read-level access check and cursor
   * convention (nextCursor present only when a full page came back). Includes the script and
   * Jev's checks so a past overview can be re-read, and a fresh proxy URL for the audio when it
   * has been rendered (`audio` is null until then). */
  static async list(caseId: string, userId: string, filters: { limit?: number; cursor?: string } = {}) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const rows = await ChatRepo.listAudioOverviewsByCase(caseId, filters);
    const items = rows.map((row) => ({
      id: row.id,
      messageId: row.messageId,
      consultationId: row.message.consultationId,
      createdAt: row.createdAt,
      status: row.audioStatus,
      turns: row.turns as unknown as AudioOverviewTurn[],
      checks: (row.checks as unknown as AudioOverviewTurnCheck[] | null) ?? [],
      audio: row.audioFile?.s3Key ? { id: row.audioFile.id, fileUrl: getProxyFileUrl(row.audioFile.s3Key, { filename: audioOverviewFilename(row.createdAt) }) } : null,
    }));
    const nextCursor = filters.limit && items.length === filters.limit ? items[items.length - 1]!.id : null;
    return { items, nextCursor };
  }
}
