-- Lawyers' manual edits in the Terminal's panes, for the Change Summary (ManualEditLog), and when
-- each analysis run began, so "edits since the previous run" can leave out edits made during it.
ALTER TABLE "CaseChangeSummary" ADD COLUMN "startedAt" TIMESTAMP(3);

CREATE TABLE "CaseManualEdit" (
    "id"        TEXT NOT NULL,
    "caseId"    TEXT NOT NULL,
    "actorId"   TEXT,
    "pane"      TEXT NOT NULL,
    "kind"      TEXT NOT NULL,
    "itemId"    TEXT,
    "action"    TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "changes"   JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseManualEdit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseManualEdit_caseId_createdAt_idx" ON "CaseManualEdit"("caseId", "createdAt");
CREATE INDEX "CaseManualEdit_caseId_actorId_itemId_idx" ON "CaseManualEdit"("caseId", "actorId", "itemId");

ALTER TABLE "CaseManualEdit" ADD CONSTRAINT "CaseManualEdit_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseManualEdit" ADD CONSTRAINT "CaseManualEdit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
