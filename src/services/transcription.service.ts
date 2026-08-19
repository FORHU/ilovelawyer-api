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
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET } from "../config";

const SUPPORTED_FORMATS = ["mp3", "wav", "flac", "ogg", "webm", "weba", "m4a", "mp4", "amr"];

function getMediaFormat(s3Key: string): string | undefined {
  const ext = s3Key.split(".").pop()?.toLowerCase();
  return SUPPORTED_FORMATS.includes(ext ?? "") ? ext : undefined;
}

function getTranscribeClient() {
  return new TranscribeClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
}

export default class TranscriptionSvc {
  static async list(userId: string) {
    return TranscriptionRepo.findAllByUser(userId);
  }

  static async listByCase(userId: string, caseId: string) {
    return TranscriptionRepo.findAllByCase(userId, caseId);
  }

  static async getById(id: string, userId: string) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);
    return item;
  }

  static async create(userId: string, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    return TranscriptionRepo.create(userId, {
      title: data.title ?? "Untitled Transcription",
      ...data,
    });
  }

  static async startBatchJob(id: string, userId: string) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);

    const s3Key = item.audioFile?.s3Key;
    if (!s3Key) throw new HttpError("No audio file or S3 key linked to this transcription", 400);
    if (!AWS_S3_BUCKET) throw new HttpError("AWS_S3_BUCKET is not configured", 500);

    const s3Uri = `s3://${AWS_S3_BUCKET}/${s3Key}`;
    const jobName = `transcription-${id}-${Date.now()}`;
    const mediaFormat = getMediaFormat(s3Key);

    const client = getTranscribeClient();
    const params: any = {
      TranscriptionJobName: jobName,
      IdentifyLanguage: true,
      LanguageOptions: ["en-US", "tl-PH", "ko-KR"],
      Media: { MediaFileUri: s3Uri },
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 10 },
    };
    if (mediaFormat) params.MediaFormat = mediaFormat;

    try {
      await client.send(new StartTranscriptionJobCommand(params));
    } catch (err) {
      logger.error("Failed to start AWS Transcribe job", { err, transcriptionId: id, jobName, s3Uri });
      throw new HttpError(
        `Failed to start transcription${err instanceof Error ? `: ${err.message}` : ""}`,
        502,
      );
    }

    await TranscriptionRepo.update(id, userId, { jobName, status: "IN_PROGRESS" });

    return { jobName, status: "IN_PROGRESS" };
  }

  static async pollJobStatus(id: string, userId: string) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);
    if (!item.jobName) throw new HttpError("No transcription job started for this record", 400);

    const client = getTranscribeClient();

    let data;
    try {
      data = await client.send(new GetTranscriptionJobCommand({ TranscriptionJobName: item.jobName }));
    } catch (err) {
      logger.error("Failed to poll AWS Transcribe job", { err, transcriptionId: id, jobName: item.jobName });
      throw new HttpError(
        `Failed to check transcription status${err instanceof Error ? `: ${err.message}` : ""}`,
        502,
      );
    }

    const job = data.TranscriptionJob;
    if (!job) throw new HttpError("Job not found in AWS Transcribe", 404);

    const status = job.TranscriptionJobStatus ?? "UNKNOWN";

    if (status === "COMPLETED" && job.Transcript?.TranscriptFileUri) {
      const transcriptText = await fetchTranscriptText(job.Transcript.TranscriptFileUri);
      await TranscriptionRepo.update(id, userId, { status, transcript: transcriptText });
      return { status, transcript: transcriptText };
    }

    if (status === "FAILED") {
      logger.error("AWS Transcribe job failed", { transcriptionId: id, jobName: item.jobName, failureReason: job.FailureReason });
      await TranscriptionRepo.update(id, userId, { status });
      return { status, failureReason: job.FailureReason };
    }

    return { status };
  }

  static async update(id: string, userId: string, data: {
    title?: string;
    transcript?: string;
    duration?: number;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);
    await TranscriptionRepo.update(id, userId, data);
    return TranscriptionRepo.findById(id, userId);
  }

  static async delete(id: string, userId: string) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);
    await TranscriptionRepo.delete(id, userId);
  }

  /** Chunk → embed → store the transcript text (ADR 0013), same shared pipeline the Case
   * Document RAG pipeline uses. Idempotent: re-running deletes and re-inserts fresh chunks.
   * Ownership is checked here (userId-scoped findById); the pipeline itself operates unscoped. */
  static async chunk(id: string, userId: string) {
    const item = await TranscriptionRepo.findById(id, userId);
    if (!item) throw new HttpError("Transcription not found", 404);
    return TranscriptionExtractionSvc.process(id);
  }
}

async function fetchTranscriptText(url: string): Promise<string> {
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
        fullTranscript += `[TS:${currentStartTime.toFixed(2)}] [${currentSpeaker}]: ${text}\n\n`;
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
      fullTranscript += `[TS:${currentStartTime.toFixed(2)}] [${currentSpeaker}]: ${text}\n\n`;
    }

    return fullTranscript.trim() || (data.results.transcripts?.[0]?.transcript ?? "");
  } catch {
    return "";
  }
}
