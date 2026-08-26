// src/server.ts
import app from "./app";
import DocumentExtractionQueue from "./queues/document-extraction.queue";
import AudioOverviewQueue from "./queues/audio-overview.queue";
import CaseReconstructionAudioQueue from "./queues/case-reconstruction-audio.queue";

import { PORT } from "./config";

DocumentExtractionQueue.start();
AudioOverviewQueue.start();
CaseReconstructionAudioQueue.start();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
