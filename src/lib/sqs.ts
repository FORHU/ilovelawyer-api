import {
  SQSClient,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_SQS_ENDPOINT } from "../config";
import logger from "../utils/logger";

const client = new SQSClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  // Only SQS is redirected to LocalStack in dev — S3/Polly/Textract (src/utils/s3.ts,
  // src/utils/polly.ts, src/utils/ocr.ts) keep talking to real AWS with the same credentials.
  ...(AWS_SQS_ENDPOINT ? { endpoint: AWS_SQS_ENDPOINT } : {}),
});

// Long-poll the whole 20s window — this is what makes SQS receive behave like Redis's BRPOP
// (block until a message arrives or the wait elapses) instead of tight-loop polling.
const WAIT_TIME_SECONDS = 20;
// Hard ceiling from the SQS API itself, independent of any queue's own CONCURRENCY.
const MAX_BATCH_SIZE = 10;
// How long to pause a queue's fetch loop after a failed receive, since a fast-failing request
// (e.g. NonExistentQueue) skips the WAIT_TIME_SECONDS long-poll that would otherwise throttle it.
const RECEIVE_ERROR_BACKOFF_MS = 5000;

export interface ReceivedMessage {
  body: string;
  receiptHandle: string;
  /** The SQS-assigned id for this delivery — same id logged by sendMessage's "SQS: message
   * sent", so a job's whole SQS lifecycle (sent -> received -> acked) can be traced by it. */
  messageId: string;
}

/** `delaySeconds`, when given, makes the message invisible to receivers until it elapses (SQS
 * caps this at 900 — 15 minutes). Used by AiGenerationQueue's "casePostExtraction" kind to
 * durably schedule the auto-refresh quiet window on SQS itself rather than an in-process timer
 * (see queues/case-post-extraction.ts) — the delay then survives a restart or a multi-instance
 * deploy instead of living in one process's memory. */
export async function sendMessage(queueUrl: string, body: string, delaySeconds?: number): Promise<string | undefined> {
  const result = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      ...(delaySeconds ? { DelaySeconds: delaySeconds } : {}),
    }),
  );
  logger.info("SQS: message sent", { queueUrl, bytes: body.length, messageId: result.MessageId, delaySeconds });
  // The queue's own SQS-assigned id — callers that want to correlate it with their own domain
  // id (e.g. CaseGraphPromotionQueue's assistantMessageId) log that pairing themselves; this
  // generic wrapper has no idea what's inside `body`.
  return result.MessageId;
}

/** SQS batches cap at 10 entries per call — chunks larger payloads transparently. */
export async function sendMessageBatch(queueUrl: string, bodies: string[]): Promise<void> {
  for (let i = 0; i < bodies.length; i += MAX_BATCH_SIZE) {
    const chunk = bodies.slice(i, i + MAX_BATCH_SIZE);
    const result = await client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((body, idx) => ({ Id: String(i + idx), MessageBody: body })),
      }),
    );
    logger.info("SQS: batch sent", {
      queueUrl,
      count: chunk.length,
      messageIds: (result.Successful ?? []).map((e) => e.MessageId),
    });
  }
}

/** Long-polls for up to `maxMessages` (capped at the SQS API's own limit of 10). Never throws —
 * a receive failure (network blip, bad queue URL) just yields no messages, same as an empty
 * BRPOP timeout, so callers' existing retry-by-looping behavior doesn't need special-casing.
 *
 * `visibilityTimeoutSeconds`, when given, overrides the queue's own configured default the
 * instant a message is received — this is what makes withVisibilityHeartbeat's renewal safe
 * regardless of what default a queue happens to be provisioned with (often a bare 30s): the
 * message's real timeout is the caller's app-level value from the very first moment, not
 * whatever the queue's static AWS-side setting is, so there's no gap before the first renewal. */
export async function receiveMessages(
  queueUrl: string,
  maxMessages: number,
  visibilityTimeoutSeconds?: number,
): Promise<ReceivedMessage[]> {
  const capped = Math.max(1, Math.min(maxMessages, MAX_BATCH_SIZE));
  try {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: capped,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        ...(visibilityTimeoutSeconds ? { VisibilityTimeout: visibilityTimeoutSeconds } : {}),
      }),
    );
    const messages = (result.Messages ?? [])
      .filter((m): m is typeof m & { Body: string; ReceiptHandle: string } => !!m.Body && !!m.ReceiptHandle)
      .map((m) => ({ body: m.Body, receiptHandle: m.ReceiptHandle, messageId: m.MessageId ?? "" }));
    // Only logged when something actually arrived — every queue's fetchLoop long-polls this in
    // a tight while(running) loop, so logging every empty 20s poll would flood the logs with
    // nothing but noise across every queue, all the time.
    if (messages.length) {
      logger.info("SQS: messages received", { queueUrl, count: messages.length, messageIds: messages.map((m) => m.messageId) });
    }
    return messages;
  } catch (err) {
    // Previously silent (bare `return []`, same as the normal "nothing to receive" case) — a
    // real ReceiveMessage failure (bad queue URL, network blip, throttling) was indistinguishable
    // from an empty poll. Still never throws (callers' loop-and-retry behavior doesn't change).
    logger.warn("SQS: receive failed", { queueUrl, err });
    // A failed request returns instantly instead of long-polling for WAIT_TIME_SECONDS, which is
    // normally what throttles each queue's `while (running)` fetch loop. Without this delay, a
    // persistently broken endpoint (e.g. LocalStack down or a queue never created in dev) makes
    // every queue spin as fast as the event loop allows, flooding stdout with this same stack
    // trace thousands of times a second.
    await new Promise((resolve) => setTimeout(resolve, RECEIVE_ERROR_BACKOFF_MS));
    return [];
  }
}

export async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
  await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

/**
 * Runs `job` while periodically renewing the message's visibility timeout — without this, any
 * job that outlives the queue's configured visibility timeout (SQS defaults to 30s; several of
 * these jobs — PDF extraction, multi-turn Polly synthesis, a 10-minute Case Reconstruction
 * audio poll — routinely run far longer) would become visible to another worker mid-flight and
 * get processed a second time. Redis's BRPOP never had this failure mode (a pop is destructive
 * immediately), so this is the one real behavioral gap the SQS migration has to close.
 *
 * `receiptHandle` is null for in-memory-fallback items that were never a real SQS message
 * (an enqueue-send failure, or a row re-queued from the DB on boot) — nothing to renew there,
 * so the job just runs directly.
 */
export async function withVisibilityHeartbeat<T>(
  queueUrl: string,
  receiptHandle: string | null,
  visibilityTimeoutSeconds: number,
  job: () => Promise<T>,
): Promise<T> {
  if (!receiptHandle) return job();

  const renewEveryMs = Math.max(5_000, (visibilityTimeoutSeconds * 1000) / 3);
  const interval = setInterval(() => {
    client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: visibilityTimeoutSeconds }))
      .catch(() => {});
  }, renewEveryMs);

  try {
    return await job();
  } finally {
    clearInterval(interval);
  }
}
