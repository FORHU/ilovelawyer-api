import { PollyClient, StartSpeechSynthesisTaskCommand, GetSpeechSynthesisTaskCommand } from "@aws-sdk/client-polly";
import CaseAccess from "../utils/case-access";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import FilesRepo from "../repositories/files.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET } from "../config";
import { getPresignedGetUrl } from "../utils/s3";

// Fixed voice for v1 — AWS Polly has no Filipino/Tagalog voice at all, and narrative
// generation has no language parameter yet, so mapping voice to Display Language is
// deferred work rather than a v1 blocker. See docs/adr context in the plan this shipped from.
const VOICE_ID = "Joanna";
const OUTPUT_PREFIX = "case-reconstruction-audio/";

function getPollyClient() {
  return new PollyClient({
    region: AWS_REGION,
    credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
}

/** Polly's own OutputUri is the authoritative, guaranteed-correct link to what it wrote —
 * trust it directly rather than reconstructing the key from OutputS3KeyPrefix + TaskId
 * (undocumented separator convention, not worth guessing). This just extracts a bucket-
 * relative s3Key from it for the File row, matching this codebase's File.s3Key convention;
 * fileUrl (the only field <audio src> actually needs) is Polly's OutputUri unmodified. */
function keyFromOutputUri(outputUri: string, bucket: string): string {
  try {
    const url = new URL(outputUri);
    let path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (path.startsWith(`${bucket}/`)) path = path.slice(bucket.length + 1);
    return path;
  } catch {
    return outputUri;
  }
}

export default class CaseReconstructionAudioSvc {
  /** Audio narrates the General/narrative register only — see the plan's scope decision:
   * extending Polly synthesis to the Court/Opposing registers too would triple per-case
   * audio cost with no request behind it yet. */
  /** userId is optional so case-post-extraction.ts's background job can auto-start narration
   * right after CaseReconstructionSvc.generate — same pattern as generate() itself. */
  static async startAudioJob(caseId: string, userId?: string) {
    if (userId) await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseReconstructionRepo.get(caseId);
    if (!row) throw new HttpError("Case reconstruction not found — generate one first", 404);
    if (!row.narrative) throw new HttpError("No narrative to narrate yet", 400);
    if (!AWS_S3_BUCKET) throw new HttpError("AWS_S3_BUCKET is not configured", 500);

    const client = getPollyClient();
    let taskId: string;
    try {
      const result = await client.send(
        new StartSpeechSynthesisTaskCommand({
          Text: row.narrative,
          OutputFormat: "mp3",
          VoiceId: VOICE_ID,
          Engine: "neural",
          OutputS3BucketName: AWS_S3_BUCKET,
          OutputS3KeyPrefix: OUTPUT_PREFIX,
        }),
      );
      taskId = result.SynthesisTask?.TaskId ?? "";
      if (!taskId) throw new Error("Polly returned no TaskId");
    } catch (err) {
      logger.error("Failed to start Polly synthesis task", { err, caseId });
      throw new HttpError(`Failed to start audio generation${err instanceof Error ? `: ${err.message}` : ""}`, 502);
    }

    await CaseReconstructionRepo.updateAudio(caseId, { audioJobName: taskId, audioStatus: "IN_PROGRESS", audioStaleAt: null });
    return { jobName: taskId, status: "IN_PROGRESS" };
  }

  /** userId is optional so CaseReconstructionAudioQueue's background poll loop can call this
   * without a request-bound user — same pattern as startAudioJob. */
  static async pollAudioJob(caseId: string, userId?: string) {
    if (userId) await CaseAccess.loadAccessibleCase(caseId, userId);
    const row = await CaseReconstructionRepo.get(caseId);
    if (!row) throw new HttpError("Case reconstruction not found", 404);
    if (!row.audioJobName) throw new HttpError("No audio job started for this reconstruction", 400);

    const client = getPollyClient();
    let task;
    try {
      const result = await client.send(new GetSpeechSynthesisTaskCommand({ TaskId: row.audioJobName }));
      task = result.SynthesisTask;
    } catch (err) {
      logger.error("Failed to poll Polly synthesis task", { err, caseId, jobName: row.audioJobName });
      throw new HttpError(`Failed to check audio status${err instanceof Error ? `: ${err.message}` : ""}`, 502);
    }
    if (!task) throw new HttpError("Task not found in Polly", 404);

    const status = task.TaskStatus ?? "unknown";

    if (status === "completed" && task.OutputUri) {
      const key = AWS_S3_BUCKET ? keyFromOutputUri(task.OutputUri, AWS_S3_BUCKET) : task.OutputUri;
      const file = await FilesRepo.create(`case-reconstruction-${caseId}.mp3`, task.OutputUri, key);
      await CaseReconstructionRepo.updateAudio(caseId, { audioFileId: file.id, audioStatus: "COMPLETED", audioStaleAt: null });
      return { status: "COMPLETED", audioFile: { id: file.id, fileUrl: await getPresignedGetUrl(key) } };
    }

    if (status === "failed") {
      logger.error("Polly synthesis task failed", { caseId, jobName: row.audioJobName, reason: task.TaskStatusReason });
      await CaseReconstructionRepo.updateAudio(caseId, { audioStatus: "FAILED" });
      return { status: "FAILED", failureReason: task.TaskStatusReason };
    }

    return { status: "IN_PROGRESS" };
  }
}
