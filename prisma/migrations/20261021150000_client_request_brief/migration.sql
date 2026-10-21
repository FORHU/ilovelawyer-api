-- The anonymised brief matching lawyers see, and what the case looked like when it was written.
-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "brief" JSONB,
ADD COLUMN     "briefError" TEXT,
ADD COLUMN     "briefFingerprint" TEXT,
ADD COLUMN     "briefGeneratedAt" TIMESTAMP(3);

