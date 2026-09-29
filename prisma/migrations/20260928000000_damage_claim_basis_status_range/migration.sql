-- CreateEnum
CREATE TYPE "DamageStatus" AS ENUM ('PROVISIONAL', 'SUPPORTED', 'CERTIFIED');

-- CreateEnum
CREATE TYPE "DamageSource" AS ENUM ('MANUAL', 'AI');

-- CreateEnum
CREATE TYPE "DamageJevSupport" AS ENUM ('SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "damagesExtractedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DamageClaim" ADD COLUMN     "aiProposedBasis" JSONB,
ADD COLUMN     "amountHigh" DOUBLE PRECISION,
ADD COLUMN     "amountLow" DOUBLE PRECISION,
ADD COLUMN     "basis" JSONB,
ADD COLUMN     "jevAwardability" INTEGER,
ADD COLUMN     "jevCheckedAt" TIMESTAMP(3),
ADD COLUMN     "jevConfidence" DOUBLE PRECISION,
ADD COLUMN     "jevSupport" "DamageJevSupport",
ADD COLUMN     "label" TEXT,
ADD COLUMN     "legalBasis" TEXT,
ADD COLUMN     "pendingEvidence" TEXT,
ADD COLUMN     "source" "DamageSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceDocumentId" TEXT,
ADD COLUMN     "sourceQuote" TEXT,
ADD COLUMN     "status" "DamageStatus" NOT NULL DEFAULT 'PROVISIONAL';

-- AddForeignKey
ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

