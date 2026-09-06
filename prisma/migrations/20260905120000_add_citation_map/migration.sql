-- CreateEnum
CREATE TYPE "CitationTreatment" AS ENUM ('FOLLOWED', 'DISTINGUISHED', 'ABANDONED', 'OVERRULED', 'CITED');

-- AlterTable
ALTER TABLE "Law" ADD COLUMN     "citationsExtractedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CitationCheck" ADD COLUMN     "resolvedLawId" TEXT,
ADD COLUMN     "resolutionConfidence" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "CitationEdge" (
    "id" TEXT NOT NULL,
    "fromLawId" TEXT NOT NULL,
    "toLawId" TEXT,
    "toRawReference" TEXT,
    "toRawTitle" TEXT,
    "treatment" "CitationTreatment" NOT NULL,
    "excerpt" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CitationEdge_fromLawId_idx" ON "CitationEdge"("fromLawId");

-- CreateIndex
CREATE INDEX "CitationCheck_resolvedLawId_idx" ON "CitationCheck"("resolvedLawId");

-- AddForeignKey
ALTER TABLE "CitationCheck" ADD CONSTRAINT "CitationCheck_resolvedLawId_fkey" FOREIGN KEY ("resolvedLawId") REFERENCES "Law"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationEdge" ADD CONSTRAINT "CitationEdge_fromLawId_fkey" FOREIGN KEY ("fromLawId") REFERENCES "Law"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationEdge" ADD CONSTRAINT "CitationEdge_toLawId_fkey" FOREIGN KEY ("toLawId") REFERENCES "Law"("id") ON DELETE SET NULL ON UPDATE CASCADE;
