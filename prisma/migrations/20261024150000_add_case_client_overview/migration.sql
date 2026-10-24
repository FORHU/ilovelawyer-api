-- CreateTable
CREATE TABLE "CaseClientOverview" (
    "caseId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3),
    "readySetFingerprint" TEXT,
    "documentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "panes" JSONB,
    "runDay" DATE,
    "runsOnDay" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseClientOverview_pkey" PRIMARY KEY ("caseId")
);

-- AddForeignKey
ALTER TABLE "CaseClientOverview" ADD CONSTRAINT "CaseClientOverview_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
