import { randomUUID } from "crypto";
import ChatRepo from "../repositories/chat.repository";
import FilesRepo from "../repositories/files.repository";
import logger from "../utils/logger";
import { uploadToS3 } from "../utils/s3";
import { AudioOverviewTurn } from "../utils/response-parser";
import { mergeTurnsToMp3 } from "../utils/audio-overview-render";
import { neuralVoiceFor } from "../utils/audio-overview-voices";
import { AUDIO_OVERVIEW_OUTPUT_PREFIX } from "../constants";

export default class AudioOverviewAudioSvc {
  /** Pulled by AudioOverviewQueue — never throws, always resolves audioStatus to COMPLETED or
   * FAILED, same contract as DocumentExtractionSvc.process. `key` is the overview row's id, or
   * the chat message id older queue messages carried. Chat-made and case-owned overviews (the
   * case analysis's) render the same way. */
  static async process(key: string): Promise<void> {
    const row = await ChatRepo.findAudioOverviewByKey(key).catch((err) => {
      logger.error("Audio Overview: failed to load the overview to render", { err, key });
      return null;
    });
    if (!row) {
      logger.error("Audio Overview: no MessageAudioOverview row to render", { key });
      return;
    }
    const id = row.id;
    try {

      const turns = row.turns as unknown as AudioOverviewTurn[];
      if (!Array.isArray(turns) || turns.length === 0) {
        await ChatRepo.updateAudioOverviewAudio(id, { audioStatus: "FAILED" });
        return;
      }

      logger.info("Audio Overview: rendering started", { id, turns: turns.length });
      const { buffer, turnTimings, sentenceTimings, wordTimings } = await mergeTurnsToMp3(
        turns,
        neuralVoiceFor(row.voiceHostA),
        neuralVoiceFor(row.voiceHostB),
      );

      const s3Key = `${AUDIO_OVERVIEW_OUTPUT_PREFIX}${id}-${randomUUID()}.mp3`;
      const fileUrl = await uploadToS3(s3Key, buffer, "audio/mpeg");
      const file = await FilesRepo.create(`audio-overview-${id}.mp3`, fileUrl, s3Key);

      await ChatRepo.updateAudioOverviewAudio(id, {
        audioFileId: file.id,
        audioStatus: "COMPLETED",
        turnTimings,
        sentenceTimings,
        wordTimings,
      });
      logger.info("Audio Overview: rendering completed", { id, fileId: file.id });
    } catch (err) {
      logger.error("Audio Overview: rendering failed", { err, id });
      await ChatRepo.updateAudioOverviewAudio(id, { audioStatus: "FAILED" }).catch((updateErr) => {
        logger.error("Audio Overview: failed to record FAILED status", { updateErr, id });
      });
    }
  }
}
