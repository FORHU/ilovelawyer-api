-- CreateTable
CREATE TABLE "CaseClientIntake" (
    "caseId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3),
    "fingerprint" TEXT,
    "data" JSONB,
    "runDay" DATE,
    "runsOnDay" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseClientIntake_pkey" PRIMARY KEY ("caseId")
);

-- AddForeignKey
ALTER TABLE "CaseClientIntake" ADD CONSTRAINT "CaseClientIntake_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
