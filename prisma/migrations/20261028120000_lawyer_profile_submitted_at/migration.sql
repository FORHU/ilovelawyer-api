-- When a lawyer's client request profile joined the admin verification queue (ilovelawyer-api#506).
-- AlterTable
ALTER TABLE "LawyerClientProfile" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- Existing submissions have no recorded date; updatedAt is the closest one they have.
UPDATE "LawyerClientProfile" SET "submittedAt" = "updatedAt" WHERE "verificationStatus" <> 'UNSUBMITTED';

-- DropIndex
DROP INDEX "LawyerClientProfile_verificationStatus_idx";

-- CreateIndex
CREATE INDEX "LawyerClientProfile_verificationStatus_submittedAt_idx" ON "LawyerClientProfile"("verificationStatus", "submittedAt");
