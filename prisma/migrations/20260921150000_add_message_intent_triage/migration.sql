-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "intent" TEXT,
ADD COLUMN     "intentConfidence" DOUBLE PRECISION;
