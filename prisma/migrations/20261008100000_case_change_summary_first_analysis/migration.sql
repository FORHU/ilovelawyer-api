-- A case's first analysis: every pane was empty before it, so the Terminal's "what changed"
-- banner stays quiet for it (CaseChangeRun.save).
ALTER TABLE "CaseChangeSummary" ADD COLUMN "firstAnalysis" BOOLEAN NOT NULL DEFAULT false;
