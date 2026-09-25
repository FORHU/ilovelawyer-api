-- CreateEnum
CREATE TYPE "ContradictionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ContradictionNature" AS ENUM ('DIRECT', 'INFERENTIAL', 'NOT_A_CONFLICT');

-- AlterTable
ALTER TABLE "EvidenceContradiction" ADD COLUMN     "nature" "ContradictionNature",
ADD COLUMN     "natureConfidence" DOUBLE PRECISION,
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "status" "ContradictionStatus" NOT NULL DEFAULT 'OPEN';

