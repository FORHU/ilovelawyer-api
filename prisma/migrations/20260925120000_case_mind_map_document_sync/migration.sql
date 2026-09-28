-- AlterTable
ALTER TABLE "CaseMindMap" ADD COLUMN     "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "retiredAt" TIMESTAMP(3);

