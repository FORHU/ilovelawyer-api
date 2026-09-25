-- CreateEnum
CREATE TYPE "WitnessSource" AS ENUM ('MANUAL', 'AI');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "witnessesExtractedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Witness" ADD COLUMN     "source" "WitnessSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceDocumentId" TEXT,
ADD COLUMN     "sourceQuote" TEXT;

-- AddForeignKey
ALTER TABLE "Witness" ADD CONSTRAINT "Witness_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
