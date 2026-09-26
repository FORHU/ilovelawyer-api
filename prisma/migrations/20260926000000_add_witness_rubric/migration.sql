-- AlterTable
ALTER TABLE "Witness" ADD COLUMN     "aiFactors" JSONB,
ADD COLUMN     "aiRubricVersion" INTEGER,
ADD COLUMN     "factorOverrides" JSONB;
