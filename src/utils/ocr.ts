import { AWS_ACCESS_KEY, AWS_REGION, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET } from "../config";
import logger from "./logger";

const TEXTRACT_SYNC_MAX_BYTES = 5 * 1024 * 1024;

type TextractBlock = { BlockType?: string; Text?: string; Page?: number };

/** Runs AWS Textract's synchronous DetectDocumentText on raw document bytes — a JPEG/PNG image
 * (the image-upload extraction path). Sync Textract only accepts single-page input, which is
 * fine here since a single image has no page concept; scanned PDFs use ocrPdfFromS3 below
 * instead, since a PDF may have multiple pages or exceed this API's 5MB/10MB limits. */
export async function ocrDocument(buffer: Buffer): Promise<string> {
  if (!AWS_ACCESS_KEY || !AWS_SECRET_ACCESS_KEY) {
    logger.warn("OCR skipped: AWS credentials not configured");
    return "";
  }
  if (buffer.length > TEXTRACT_SYNC_MAX_BYTES) {
    logger.warn("OCR skipped: document exceeds Textract sync limit", { bytes: buffer.length });
    return "";
  }

  try {
    // Optional dependency — OCR is skipped if the client is not installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const textract = require("@aws-sdk/client-textract") as {
      TextractClient: new (cfg: object) => { send: (cmd: unknown) => Promise<{ Blocks?: TextractBlock[] }> };
      DetectDocumentTextCommand: new (input: object) => unknown;
    };
    const client = new textract.TextractClient({
      region: AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: AWS_ACCESS_KEY,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
    const result = await client.send(
      new textract.DetectDocumentTextCommand({
        Document: { Bytes: buffer },
      }),
    );
    const lines = (result.Blocks ?? [])
      .filter((block: TextractBlock) => block.BlockType === "LINE" && block.Text)
      .map((block: TextractBlock) => block.Text as string);
    return lines.join("\n");
  } catch (err) {
    logger.warn("OCR via Textract failed", { err });
    return "";
  }
}

const TEXTRACT_ASYNC_POLL_INTERVAL_MS = 3_000;
// ~10 minutes of polling — generous for a large multi-page scan. The SQS visibility timeout
// around the whole extraction job is kept renewed the entire time (withVisibilityHeartbeat in
// document-extraction.service.ts's caller), so a slow job here can't cause a duplicate pickup.
const TEXTRACT_ASYNC_MAX_POLL_ATTEMPTS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OcrPage {
  pageNumber: number;
  text: string;
}

/** Runs AWS Textract's asynchronous StartDocumentTextDetection/GetDocumentTextDetection on a PDF
 * already sitting in S3 — the scanned-PDF fallback in document-text-extraction.ts. Unlike
 * ocrDocument's synchronous DetectDocumentText, this handles multi-page PDFs (sync Textract only
 * accepts single-page input and rejects the rest with UnsupportedDocumentException) and PDFs well
 * past sync's 5MB/10MB byte limits (async supports up to 500MB / 3000 pages). Reads the object
 * straight from S3 instead of the buffer already in memory, since that's what this API expects. */
export async function ocrPdfFromS3(s3Key: string): Promise<OcrPage[]> {
  if (!AWS_ACCESS_KEY || !AWS_SECRET_ACCESS_KEY) {
    logger.warn("OCR skipped: AWS credentials not configured");
    return [];
  }
  if (!AWS_S3_BUCKET) {
    logger.warn("OCR skipped: AWS_S3_BUCKET not configured");
    return [];
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const textract = require("@aws-sdk/client-textract") as {
      TextractClient: new (cfg: object) => { send: (cmd: unknown) => Promise<Record<string, unknown>> };
      StartDocumentTextDetectionCommand: new (input: object) => unknown;
      GetDocumentTextDetectionCommand: new (input: object) => unknown;
    };
    const client = new textract.TextractClient({
      region: AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: AWS_ACCESS_KEY,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });

    const startResult = (await client.send(
      new textract.StartDocumentTextDetectionCommand({
        DocumentLocation: { S3Object: { Bucket: AWS_S3_BUCKET, Name: s3Key } },
      }),
    )) as { JobId?: string };
    const jobId = startResult.JobId;
    if (!jobId) {
      logger.warn("OCR skipped: Textract did not return a JobId", { s3Key });
      return [];
    }

    let status: string | undefined;
    for (let attempt = 0; attempt < TEXTRACT_ASYNC_MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(TEXTRACT_ASYNC_POLL_INTERVAL_MS);
      const poll = (await client.send(new textract.GetDocumentTextDetectionCommand({ JobId: jobId }))) as {
        JobStatus?: string;
      };
      status = poll.JobStatus;
      if (status === "SUCCEEDED" || status === "FAILED" || status === "PARTIAL_SUCCESS") break;
    }

    if (status !== "SUCCEEDED" && status !== "PARTIAL_SUCCESS") {
      logger.warn("OCR via Textract (async) did not succeed", { s3Key, jobId, status });
      return [];
    }

    const linesByPage = new Map<number, string[]>();
    let nextToken: string | undefined;
    do {
      const page = (await client.send(
        new textract.GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }),
      )) as { Blocks?: TextractBlock[]; NextToken?: string };
      for (const block of page.Blocks ?? []) {
        if (block.BlockType !== "LINE" || !block.Text) continue;
        const pageNumber = block.Page ?? 1;
        const lines = linesByPage.get(pageNumber);
        if (lines) lines.push(block.Text);
        else linesByPage.set(pageNumber, [block.Text]);
      }
      nextToken = page.NextToken;
    } while (nextToken);

    return [...linesByPage.entries()]
      .sort(([a], [b]) => a - b)
      .map(([pageNumber, lines]) => ({ pageNumber, text: lines.join("\n") }));
  } catch (err) {
    logger.warn("OCR via Textract (async) failed", { err, s3Key });
    return [];
  }
}
