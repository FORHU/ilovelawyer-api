import { randomUUID } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import FilesRepo from "../repositories/files.repository";
import logger from "../utils/logger";
import { uploadToS3 } from "../utils/s3";
import { AudioOverviewTurn } from "../utils/response-parser";
import { mergeTurnsToMp3 } from "../utils/audio-overview-render";
import { AUDIO_OVERVIEW_OUTPUT_PREFIX } from "../constants";

export default class AudioOverviewAudioSvc {
  /** Pulled by AudioOverviewQueue — never throws, always resolves audioStatus to COMPLETED or
   * FAILED, same contract as DocumentExtractionSvc.process. */
  static async process(messageId: string): Promise<void> {
    try {
      const row = await ChatRepo.findAudioOverviewByMessageId(messageId);
      if (!row) {
        logger.error("Audio Overview: no MessageAudioOverview row for message", { messageId });
        return;
      }

      const turns = row.turns as unknown as AudioOverviewTurn[];
      if (!Array.isArray(turns) || turns.length === 0) {
        await ChatRepo.updateAudioOverviewAudio(messageId, { audioStatus: "FAILED" });
        return;
      }

      logger.info("Audio Overview: rendering started", { messageId, turns: turns.length });
      const merged = await mergeTurnsToMp3(turns, row.voiceHostA, row.voiceHostB);

      const key = `${AUDIO_OVERVIEW_OUTPUT_PREFIX}${messageId}-${randomUUID()}.mp3`;
      const fileUrl = await uploadToS3(key, merged, "audio/mpeg");
      const file = await FilesRepo.create(`audio-overview-${messageId}.mp3`, fileUrl, key);

      await ChatRepo.updateAudioOverviewAudio(messageId, { audioFileId: file.id, audioStatus: "COMPLETED" });
      logger.info("Audio Overview: rendering completed", { messageId, fileId: file.id });
    } catch (err) {
      logger.error("Audio Overview: rendering failed", { err, messageId });
      await ChatRepo.updateAudioOverviewAudio(messageId, { audioStatus: "FAILED" }).catch((updateErr) => {
        logger.error("Audio Overview: failed to record FAILED status", { updateErr, messageId });
      });
    }
  }
}
