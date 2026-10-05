-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FindingTag" ADD VALUE 'READY';
ALTER TYPE "FindingTag" ADD VALUE 'DRAFTING';
ALTER TYPE "FindingTag" ADD VALUE 'BLOCKED';
ALTER TYPE "FindingTag" ADD VALUE 'ANSWERED';
ALTER TYPE "FindingTag" ADD VALUE 'PARTIAL';
ALTER TYPE "FindingTag" ADD VALUE 'UNANSWERED';
