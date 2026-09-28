-- CreateEnum
CREATE TYPE "FindingReadiness" AS ENUM ('READY', 'DRAFTING', 'BLOCKED');

-- AlterTable
ALTER TABLE "CaseFinding" ADD COLUMN     "jevConfidence" DOUBLE PRECISION,
ADD COLUMN     "jevReadiness" "FindingReadiness",
ADD COLUMN     "readiness" "FindingReadiness",
ADD COLUMN     "readinessNote" TEXT;
