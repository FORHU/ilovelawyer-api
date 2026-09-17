// src/server.ts
import app from "./app";
import DocumentExtractionQueue from "./queues/document-extraction.queue";
import AudioOverviewQueue from "./queues/audio-overview.queue";
import CaseReconstructionAudioQueue from "./queues/case-reconstruction-audio.queue";
import CitationExtractionQueue from "./queues/citation-extraction.queue";
import AiGenerationQueue from "./queues/ai-generation.queue";
import MessagePersistenceQueue from "./queues/message-persistence.queue";
import EventReminderQueue from "./queues/event-reminder.queue";
import AccountDeletionQueue from "./queues/account-deletion.queue";

import { PORT } from "./config";

DocumentExtractionQueue.start();
AudioOverviewQueue.start();
CaseReconstructionAudioQueue.start();
CitationExtractionQueue.start();
AiGenerationQueue.start();
MessagePersistenceQueue.start();
EventReminderQueue.start();
AccountDeletionQueue.start();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
