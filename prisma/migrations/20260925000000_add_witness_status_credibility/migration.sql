-- CreateEnum
CREATE TYPE "WitnessStatus" AS ENUM ('READY', 'ADVERSE', 'OUTSTANDING');

-- AlterTable
ALTER TABLE "Witness" ADD COLUMN     "credibility" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "status" "WitnessStatus" NOT NULL DEFAULT 'OUTSTANDING',
ADD COLUMN     "summary" TEXT;
