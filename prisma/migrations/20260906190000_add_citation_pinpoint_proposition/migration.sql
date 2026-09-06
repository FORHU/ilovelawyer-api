-- CreateEnum
CREATE TYPE "CitationPropositionType" AS ENUM ('QUOTED', 'PARAPHRASED', 'INFERRED');

-- AlterTable
ALTER TABLE "CitationCheck" ADD COLUMN     "pinpoint" TEXT,
ADD COLUMN     "propositionType" "CitationPropositionType";
