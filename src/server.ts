// src/server.ts
import app from "./app";
import DocumentExtractionQueue from "./queues/document-extraction.queue";

import { PORT } from "./config";

DocumentExtractionQueue.start();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
