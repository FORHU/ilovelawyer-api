-- ConsultationTraceEvent: traces for AI work that is not a chat (witness scoring, case
-- reconstruction, red team, ...). Such a run belongs to a case and a pane, not to a consultation,
-- so consultationId (and organizationId, since Case.organizationId is itself optional) become
-- nullable, and "source" says what produced the run. Existing rows are all chat turns.

-- AlterTable
ALTER TABLE "ConsultationTraceEvent" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'chat',
ALTER COLUMN "consultationId" DROP NOT NULL,
ALTER COLUMN "organizationId" DROP NOT NULL;

-- caseId used to be a plain column, so a deleted case could leave rows pointing at nothing. Those
-- rows are unreachable (the pane reads by case) and would make the foreign key below fail.
DELETE FROM "ConsultationTraceEvent"
WHERE "caseId" IS NOT NULL AND "caseId" NOT IN (SELECT "id" FROM "Case");

-- CreateIndex
CREATE INDEX "ConsultationTraceEvent_caseId_source_idx" ON "ConsultationTraceEvent"("caseId", "source");

-- AddForeignKey
ALTER TABLE "ConsultationTraceEvent" ADD CONSTRAINT "ConsultationTraceEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
