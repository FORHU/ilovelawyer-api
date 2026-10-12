// src/extraction-worker.ts
// Standalone document-extraction consumer: the same DocumentExtractionQueue the API runs, in its
// own process, so its memory can be sized for 1 GB uploads (e.g. node --max-old-space-size) without
// a large extraction being able to take the API down. Run with DOCUMENT_EXTRACTION_IN_API=false on
// the API so only this process consumes the queue (see that flag for the live-update trade-off).
import DocumentExtractionQueue from "./queues/document-extraction.queue";
import logger from "./utils/logger";
import { verifyDocumentBucketRegion } from "./utils/s3";

void verifyDocumentBucketRegion();

DocumentExtractionQueue.start();
logger.info("Document extraction worker started");
