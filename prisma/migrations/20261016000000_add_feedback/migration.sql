-- In-app feedback from testers: the header drawer, a thumb on a chat answer, a flag on a Terminal pane.
-- Ids and the person's own words only. Deleting the user deletes their feedback.

CREATE TYPE "FeedbackSource" AS ENUM ('GENERAL', 'CHAT_ANSWER', 'TERMINAL_PANE');
CREATE TYPE "FeedbackRating" AS ENUM ('UP', 'DOWN');

CREATE TABLE "Feedback" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "source"         "FeedbackSource" NOT NULL,
  "rating"         "FeedbackRating",
  "category"       TEXT,
  "comment"        TEXT,
  "organizationId" TEXT,
  "caseId"         TEXT,
  "consultationId" TEXT,
  "messageId"      TEXT,
  "panelId"        TEXT,
  "pagePath"       TEXT,
  "userAgent"      TEXT,
  "viewport"       TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
CREATE INDEX "Feedback_source_idx" ON "Feedback"("source");

ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
