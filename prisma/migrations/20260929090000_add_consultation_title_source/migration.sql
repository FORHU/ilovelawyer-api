-- CreateEnum
CREATE TYPE "ConsultationTitleSource" AS ENUM ('AUTO', 'PROVISIONAL', 'USER');

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "titleSource" "ConsultationTitleSource";

-- Existing titles: there's no record of which were renamed by hand, and nearly all were
-- generated, so they're treated as AUTO (eligible for smart re-titling).
UPDATE "Consultation" SET "titleSource" = 'AUTO' WHERE "title" IS NOT NULL;
