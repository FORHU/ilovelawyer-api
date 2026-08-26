-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('PH', 'UK');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'PH';

-- AlterTable
ALTER TABLE "LegalSourceAnalysisCache" ADD COLUMN "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'PH';

-- DropIndex
DROP INDEX "LegalSourceAnalysisCache_normalizedKeyword_key";

-- CreateIndex
CREATE UNIQUE INDEX "LegalSourceAnalysisCache_normalizedKeyword_jurisdiction_key" ON "LegalSourceAnalysisCache"("normalizedKeyword", "jurisdiction");
