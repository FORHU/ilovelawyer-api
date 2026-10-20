-- Staff-added AI allowance per case, and an index so a case's AI spend can be summed quickly.
ALTER TABLE "Case" ADD COLUMN "extraAiAllowanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX "LlmUsage_caseId_idx" ON "LlmUsage"("caseId");
