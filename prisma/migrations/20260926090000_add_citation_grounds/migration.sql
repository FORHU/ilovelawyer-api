-- CreateEnum
CREATE TYPE "AuthoringSource" AS ENUM ('MANUAL', 'AI');

-- CreateEnum
CREATE TYPE "GroundRole" AS ENUM ('SUBSTANTIVE', 'PROCEDURAL');

-- AlterTable
ALTER TABLE "CaseClaim" ADD COLUMN     "source" "AuthoringSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceLabel" TEXT,
ADD COLUMN     "sourceQuote" TEXT;

-- CreateTable
CREATE TABLE "CitationGround" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "citationCheckId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "role" "GroundRole" NOT NULL,
    "source" "AuthoringSource" NOT NULL,
    "reason" TEXT,
    "jev" JSONB,
    "jevCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationGround_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CitationGround_caseId_idx" ON "CitationGround"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CitationGround_citationCheckId_claimId_key" ON "CitationGround"("citationCheckId", "claimId");

-- AddForeignKey
ALTER TABLE "CitationGround" ADD CONSTRAINT "CitationGround_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationGround" ADD CONSTRAINT "CitationGround_citationCheckId_fkey" FOREIGN KEY ("citationCheckId") REFERENCES "CitationCheck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationGround" ADD CONSTRAINT "CitationGround_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "CaseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

