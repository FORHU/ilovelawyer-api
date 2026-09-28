-- CreateEnum
CREATE TYPE "AdverseHitKind" AS ENUM ('OWN_STATUS', 'NEGATIVE_TREATMENT');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "adverseSweptAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdverseCitationHit" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "citationCheckId" TEXT NOT NULL,
    "kind" "AdverseHitKind" NOT NULL,
    "edgeId" TEXT,
    "treatment" "CitationTreatment",
    "citingTitle" TEXT,
    "excerpt" TEXT,
    "jev" JSONB,
    "jevCheckedAt" TIMESTAMP(3),
    "suggestionStatus" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "weaknessId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdverseCitationHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdverseCitationHit_caseId_idx" ON "AdverseCitationHit"("caseId");

-- CreateIndex
CREATE INDEX "CitationEdge_toLawId_idx" ON "CitationEdge"("toLawId");

-- AddForeignKey
ALTER TABLE "AdverseCitationHit" ADD CONSTRAINT "AdverseCitationHit_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdverseCitationHit" ADD CONSTRAINT "AdverseCitationHit_citationCheckId_fkey" FOREIGN KEY ("citationCheckId") REFERENCES "CitationCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

