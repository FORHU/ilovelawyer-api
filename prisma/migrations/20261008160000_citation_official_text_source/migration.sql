-- CreateEnum
CREATE TYPE "OfficialTextSource" AS ENUM ('LAWYER', 'PH_LAW', 'UK_LEGISLATION', 'UK_JUDGMENT');

-- AlterTable
ALTER TABLE "CitationCheck" ADD COLUMN     "officialTextRef" TEXT,
ADD COLUMN     "officialTextSource" "OfficialTextSource";

