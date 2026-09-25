-- CreateEnum
CREATE TYPE "FindingTag" AS ENUM ('CONTESTED', 'BRIEFING', 'OPEN', 'RESOLVED', 'MATERIAL', 'MINOR', 'CLOSED', 'STRONG', 'MODERATE');

-- AlterTable
ALTER TABLE "CaseFinding" ADD COLUMN     "detail" TEXT,
ADD COLUMN     "impact" INTEGER,
ADD COLUMN     "jev" JSONB,
ADD COLUMN     "jevCheckedAt" TIMESTAMP(3),
ADD COLUMN     "modelImpact" INTEGER,
ADD COLUMN     "modelTag" "FindingTag",
ADD COLUMN     "position" INTEGER,
ADD COLUMN     "tag" "FindingTag";
