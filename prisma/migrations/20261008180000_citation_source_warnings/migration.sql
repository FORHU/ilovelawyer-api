-- CreateEnum
CREATE TYPE "CitationSourceWarning" AS ENUM ('NOT_IN_FORCE', 'OUTSIDE_EXTENT');

-- AlterTable
ALTER TABLE "CitationCheck" ADD COLUMN     "sourceWarnings" "CitationSourceWarning"[] DEFAULT ARRAY[]::"CitationSourceWarning"[];

