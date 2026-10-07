-- MessageAudioOverview can now belong to the case instead of a chat message: the case analysis
-- writes one with no message behind it (AudioOverviewSvc.generateForCase). Existing rows keep
-- their messageId and get no caseId.
ALTER TABLE "MessageAudioOverview" ALTER COLUMN "messageId" DROP NOT NULL;
ALTER TABLE "MessageAudioOverview" ADD COLUMN "caseId" TEXT;

CREATE INDEX "MessageAudioOverview_caseId_idx" ON "MessageAudioOverview"("caseId");

ALTER TABLE "MessageAudioOverview" ADD CONSTRAINT "MessageAudioOverview_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner: a chat message or the case.
ALTER TABLE "MessageAudioOverview" ADD CONSTRAINT "MessageAudioOverview_one_owner"
  CHECK (("messageId" IS NOT NULL) <> ("caseId" IS NOT NULL));
