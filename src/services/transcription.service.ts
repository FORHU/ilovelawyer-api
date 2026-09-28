import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";
import axios from "axios";
import TranscriptionRepo from "../repositories/transcription.repository";
import TranscriptionExtractionSvc from "./transcription-extraction.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { AWS_S3_BUCKET } from "../config";
import { awsClientConfig } from "../lib/aws-client-config";

const SUPPORTED_FORMATS = ["mp3", "wav", "flac", "ogg", "webm", "weba", "m4a", "mp4", "amr"];

function getMediaFormat(s3Key: string): string | undefined {
  const ext = s3Key.split(".").pop()?.toLowerCase();
  return SUPPORTED_FORMATS.includes(ext ?? "") ? ext : undefined;
}

function getTranscribeClient() {
  return new TranscribeClient({ ...awsClientConfig });
}

/** Starts an AWS Transcribe batch job for audio/video already sitting in S3. Shared by
 * TranscriptionSvc.startBatchJob (Transcription page) and the Case Document extraction pipeline
 * (mp3/mp4 evidence uploads), so both use identical language/diarization settings. */
export async function startTranscribeJob(s3Key: string, jobName: string): Promise<void> {
  if (!AWS_S3_BUCKET) throw new HttpError("AWS_S3_BUCKET is not configured", 500);
  const mediaFormat = getMediaFormat(s3Key);
  const params: any = {
    TranscriptionJobName: jobName,
    IdentifyLanguage: true,
    LanguageOptions: ["en-US", "tl-PH", "ko-KR"],
    Media: { MediaFileUri: `s3://${AWS_S3_BUCKET}/${s3Key}` },
    Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 10 },
  };
  if (mediaFormat) params.MediaFormat = mediaFormat;
  await getTranscribeClient().send(new StartTranscriptionJobCommand(params));
}

export interface TranscribeJobResult {
  status: string;
  transcript?: string;
  failureReason?: string;
}

/** One-shot status check of a started job; on COMPLETED also fetches/formats the transcript. */
export async function getTranscribeJobResult(jobName: string): Promise<TranscribeJobResult> {
  const data = await getTranscribeClient().send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
  const job = data.TranscriptionJob;
  if (!job) throw new HttpError("Job not found in AWS Transcribe", 404);

  const status = job.TranscriptionJobStatus ?? "UNKNOWN";
  if (status === "COMPLETED" && job.Transcript?.TranscriptFileUri) {
    return { status, transcript: await fetchTranscriptText(job.Transcript.TranscriptFileUri) };
  }
  if (status === "FAILED") return { status, failureReason: job.FailureReason };
  return { status };
}

const TRANSCRIBE_POLL_INTERVAL_MS = 5_000;
// Kept under DocumentExtractionQueue's 15-minute JOB_HARD_TIMEOUT_MS, same as its Textract poll.
const TRANSCRIBE_MAX_WAIT_MS = 12 * 60_000;

/** Transcribes S3 media end-to-end (start job, poll to completion) and returns the formatted
 * transcript text. Throws if the job fails or times out. */
export async function transcribeS3Media(s3Key: string, jobLabel: string): Promise<string> {
  const jobName = `${jobLabel}-${Date.now()}`;
  await startTranscribeJob(s3Key, jobName);

  const deadline = Date.now() + TRANSCRIBE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_POLL_INTERVAL_MS));
    const result = await getTranscribeJobResult(jobName);
    if (result.status === "COMPLETED") return result.transcript ?? "";
    if (result.status === "FAILED") throw new Error(`AWS Transcribe job failed: ${result.failureReason ?? "unknown reason"}`);
  }
  throw new Error("Timed out waiting for AWS Transcribe job");
}

export default class TranscriptionSvc {
  static async list(organizationId: string) {
    return TranscriptionRepo.findAllByUser(organizationId);
  }

  static async listByCase(organizationId: string, caseId: string) {
    return TranscriptionRepo.findAllByCase(organizationId, caseId);
  }

  static async getById(id: string, organizationId: string) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);
    return item;
  }

  static async create(organizationId: string, userId: string, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    return TranscriptionRepo.create(organizationId, userId, {
      title: data.title ?? "Untitled Transcription",
      ...data,
    });
  }

  static async startBatchJob(id: string, organizationId: string) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);

    const s3Key = item.audioFile?.s3Key;
    if (!s3Key) throw new HttpError("No audio file or S3 key linked to this transcription", 400);
    if (!AWS_S3_BUCKET) throw new HttpError("AWS_S3_BUCKET is not configured", 500);

    const jobName = `transcription-${id}-${Date.now()}`;
    try {
      await startTranscribeJob(s3Key, jobName);
    } catch (err) {
      logger.error("Failed to start AWS Transcribe job", { err, transcriptionId: id, jobName, s3Key });
      throw new HttpError(
        `Failed to start transcription${err instanceof Error ? `: ${err.message}` : ""}`,
        502,
      );
    }

    await TranscriptionRepo.update(id, organizationId, { jobName, status: "IN_PROGRESS" });

    return { jobName, status: "IN_PROGRESS" };
  }

  static async pollJobStatus(id: string, organizationId: string) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);
    if (!item.jobName) throw new HttpError("No transcription job started for this record", 400);

    let result;
    try {
      result = await getTranscribeJobResult(item.jobName);
    } catch (err) {
      logger.error("Failed to poll AWS Transcribe job", { err, transcriptionId: id, jobName: item.jobName });
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        `Failed to check transcription status${err instanceof Error ? `: ${err.message}` : ""}`,
        502,
      );
    }

    if (result.status === "COMPLETED" && result.transcript !== undefined) {
      await TranscriptionRepo.update(id, organizationId, { status: result.status, transcript: result.transcript });
    } else if (result.status === "FAILED") {
      logger.error("AWS Transcribe job failed", { transcriptionId: id, jobName: item.jobName, failureReason: result.failureReason });
      await TranscriptionRepo.update(id, organizationId, { status: result.status });
    }
    return result;
  }

  static async update(id: string, organizationId: string, data: {
    title?: string;
    transcript?: string;
    duration?: number;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);
    await TranscriptionRepo.update(id, organizationId, data);
    return TranscriptionRepo.findById(id, organizationId);
  }

  static async delete(id: string, organizationId: string) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);
    await TranscriptionRepo.delete(id, organizationId);
  }

  /** Chunk → embed → store the transcript text (ADR 0013), same shared pipeline the Case
   * Document RAG pipeline uses. Idempotent: re-running deletes and re-inserts fresh chunks.
   * Ownership is checked here (org-scoped findById); the pipeline itself operates unscoped. */
  static async chunk(id: string, organizationId: string) {
    const item = await TranscriptionRepo.findById(id, organizationId);
    if (!item) throw new HttpError("Transcription not found", 404);
    return TranscriptionExtractionSvc.process(id);
  }
}

export async function fetchTranscriptText(url: string): Promise<string> {
  try {
    const { data } = await axios.get(url);
    if (!data?.results) return "";

    if (!data.results.speaker_labels?.segments) {
      return data.results.transcripts?.[0]?.transcript ?? "";
    }

    const wordSpeakerMap = new Map<number, string>();
    data.results.speaker_labels.segments.forEach((seg: any) => {
      seg.items?.forEach((item: any) => {
        if (item.start_time) {
          const t = parseFloat(item.start_time);
          if (!isNaN(t)) wordSpeakerMap.set(t, seg.speaker_label);
        }
      });
    });

    const getSpeaker = (startTime: number): string => {
      for (const [t, spk] of wordSpeakerMap.entries()) {
        if (Math.abs(t - startTime) < 0.005) return spk;
      }
      for (const seg of data.results.speaker_labels.segments) {
        if (startTime >= parseFloat(seg.start_time) && startTime <= parseFloat(seg.end_time)) {
          return seg.speaker_label;
        }
      }
      return "spk_0";
    };

    // AWS Transcribe's diarization always returns a speaker_labels.segments array once
    // ShowSpeakerLabels is on — even a solo recording gets every segment tagged "spk_0". Without
    // this check, a single-speaker transcript still got a "[Speaker 0]:" turn label on every
    // pause/paragraph split below, reading as a multi-person conversation transcript for a
    // recording that was never a dialogue. Only genuinely multi-speaker audio gets the tagged
    // conversational format; one detected speaker gets plain paragraph text instead.
    const speakerCount = new Set(
      data.results.speaker_labels.segments.map((seg: any) => seg.speaker_label),
    ).size;

    const items = data.results.items;
    let fullTranscript = "";
    let currentSpeaker = "";
    let currentStartTime = 0;
    let currentBuffer: string[] = [];
    let lastWordEndTime = 0;

    items.forEach((item: any) => {
      const content = item.alternatives[0].content;
      if (item.type === "punctuation") {
        currentBuffer.push(content);
        return;
      }

      const itemStart = parseFloat(item.start_time);
      const itemEnd = parseFloat(item.end_time);
      const speakerLabel = getSpeaker(itemStart);
      const speaker = `Speaker ${speakerLabel.replace("spk_", "")}`;

      const isPause = lastWordEndTime > 0 && itemStart - lastWordEndTime > 2.0;
      const lastChar = currentBuffer[currentBuffer.length - 1] ?? "";
      const isParagraphSplit = [".", "?", "!"].includes(lastChar) && currentBuffer.length >= 45;
      const shouldSplit = speaker !== currentSpeaker || isPause || isParagraphSplit;

      if (currentSpeaker === "") {
        currentSpeaker = speaker;
        currentStartTime = itemStart;
        currentBuffer.push(content);
      } else if (shouldSplit) {
        let text = currentBuffer.join(" ").replace(/ ([,.!?;:])/g, "$1");
        text = text.charAt(0).toUpperCase() + text.slice(1);
        if (!/[.!?]$/.test(text)) text += ".";
        fullTranscript +=
          speakerCount > 1 ? `[TS:${currentStartTime.toFixed(2)}] [${currentSpeaker}]: ${text}\n\n` : `${text}\n\n`;
        currentSpeaker = speaker;
        currentStartTime = itemStart;
        currentBuffer = [content];
      } else {
        currentBuffer.push(content);
      }

      lastWordEndTime = itemEnd;
    });

    if (currentBuffer.length > 0) {
      let text = currentBuffer.join(" ").replace(/ ([,.!?;:])/g, "$1");
      text = text.charAt(0).toUpperCase() + text.slice(1);
      if (!/[.!?]$/.test(text)) text += ".";
      fullTranscript +=
        speakerCount > 1 ? `[TS:${currentStartTime.toFixed(2)}] [${currentSpeaker}]: ${text}\n\n` : `${text}\n\n`;
    }

    return fullTranscript.trim() || (data.results.transcripts?.[0]?.transcript ?? "");
  } catch {
    return "";
  }
}
