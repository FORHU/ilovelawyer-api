-- AlterTable
ALTER TABLE "Case" ADD COLUMN "clientCaseAreas" TEXT[] DEFAULT ARRAY[]::TEXT[];
