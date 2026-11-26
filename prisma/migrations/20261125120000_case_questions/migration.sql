-- The Questions step after a client's story: one row per case holding the list of details still
-- needed, sealed as one JSON blob (CaseQuestions.plan). PLANNING while the list is written.

-- CreateEnum
CREATE TYPE "CaseQuestionsStatus" AS ENUM ('PLANNING', 'OPEN', 'DONE');

-- CreateTable
CREATE TABLE "CaseQuestions" (
    "caseId" TEXT NOT NULL,
    "status" "CaseQuestionsStatus" NOT NULL DEFAULT 'PLANNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseQuestions_pkey" PRIMARY KEY ("caseId")
);

-- AddForeignKey
ALTER TABLE "CaseQuestions" ADD CONSTRAINT "CaseQuestions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
