CREATE TABLE "UserDocument" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "caseId"    TEXT,
  "name"      TEXT NOT NULL,
  "fileUrl"   TEXT,
  "s3Key"     TEXT,
  "aiSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserDocument_userId_idx" ON "UserDocument"("userId");

ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
