ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "s3Key" TEXT;

CREATE TABLE "Transcription" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "audioFileId" TEXT,
  "title"       TEXT,
  "transcript"  TEXT,
  "duration"    DOUBLE PRECISION,
  "jobName"     TEXT,
  "status"      TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Transcription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transcription_userId_idx" ON "Transcription"("userId");

ALTER TABLE "Transcription" ADD CONSTRAINT "Transcription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Transcription" ADD CONSTRAINT "Transcription_audioFileId_fkey"
  FOREIGN KEY ("audioFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
