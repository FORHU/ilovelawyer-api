-- What each analysis refresh changed in the panes it rewrote (CaseRefreshSvc), one row per run,
-- read by the Legal Terminal's "what changed" banner. Goes with the case on delete.
CREATE TABLE "CaseChangeSummary" (
    "id"               TEXT NOT NULL,
    "caseId"           TEXT NOT NULL,
    "reason"           TEXT NOT NULL,
    "actorId"          TEXT,
    "readyDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "documentsAdded"   JSONB NOT NULL DEFAULT '[]',
    "documentsRemoved" JSONB NOT NULL DEFAULT '[]',
    "totalChanges"     INTEGER NOT NULL DEFAULT 0,
    "perPaneDeltas"    JSONB NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseChangeSummary_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseChangeSummary_caseId_createdAt_idx" ON "CaseChangeSummary"("caseId", "createdAt");

ALTER TABLE "CaseChangeSummary" ADD CONSTRAINT "CaseChangeSummary_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
