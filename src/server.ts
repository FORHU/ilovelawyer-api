// src/server.ts
import app from "./app";
import DocumentExtractionQueue from "./queues/document-extraction.queue";
import AudioOverviewQueue from "./queues/audio-overview.queue";
import CitationExtractionQueue from "./queues/citation-extraction.queue";
import AiGenerationQueue from "./queues/ai-generation.queue";
import CaseGraphPromotionQueue from "./queues/case-graph-promotion.queue";
import ChatGenerationQueue from "./queues/chat-generation.queue";
import EventReminderQueue from "./queues/event-reminder.queue";
import AccountDeletionQueue from "./queues/account-deletion.queue";
import ConsultationDeletionQueue from "./queues/consultation-deletion.queue";
import OrganizationDeletionQueue from "./queues/organization-deletion.queue";
import GoogleCalendarSyncQueue from "./queues/google-calendar-sync.queue";
import CaseCopyQueue from "./queues/case-copy.queue";
import SecurityAuditRetentionQueue from "./queues/security-audit-retention.queue";

import { DOCUMENT_EXTRACTION_IN_API, FREE_CREDIT_USD, PORT } from "./config";
import logger from "./utils/logger";
import { fieldEncryptionStatus } from "./utils/field-crypto";
import { verifyDocumentBucketRegion } from "./utils/s3";
import LlmUsageSvc from "./services/llm-usage.service";

void verifyDocumentBucketRegion();

// Every Jev call (jevAsk) records its token usage in the LLM usage ledger (#403).
LlmUsageSvc.registerJevRecorder();

// Off when a separate extraction worker consumes the queue instead (see DOCUMENT_EXTRACTION_IN_API).
if (DOCUMENT_EXTRACTION_IN_API) DocumentExtractionQueue.start();
AudioOverviewQueue.start();
CitationExtractionQueue.start();
AiGenerationQueue.start();
CaseGraphPromotionQueue.start();
ChatGenerationQueue.start();
EventReminderQueue.start();
AccountDeletionQueue.start();
ConsultationDeletionQueue.start();
OrganizationDeletionQueue.start();
GoogleCalendarSyncQueue.start();
CaseCopyQueue.start();
SecurityAuditRetentionQueue.start();

if (FREE_CREDIT_USD === null) logger.error("FREE_CREDIT_USD is not set: new accounts get no free AI credit and are not limited");

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  const encryption = fieldEncryptionStatus();
  const state = encryption.enabled && encryption.keyConfigured ? "ON" : encryption.enabled ? "ENABLED BUT NO VALID KEY (privileged notes and chat messages cannot be saved)" : "OFF";
  logger.info(`Field encryption (privileged notes, document text, chat messages): ${state}`, encryption);
});
