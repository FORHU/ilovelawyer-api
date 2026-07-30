ALTER TABLE "Transcription" ADD COLUMN "caseId" TEXT;

ALTER TABLE "Transcription" ADD CONSTRAINT "Transcription_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
