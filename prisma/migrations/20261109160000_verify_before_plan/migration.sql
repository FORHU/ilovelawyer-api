-- Verify before plan (UK): new solo lawyers and firm founders get into the app once their Lawyer
-- Application is verified, then choose a plan or start the free trial. Existing accounts keep
-- today's order (verifyBeforePlan false), and every application already verified counts as
-- verified once.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planChosenAt" TIMESTAMP(3),
ADD COLUMN     "verifyBeforePlan" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LawyerClientProfile" ADD COLUMN     "firstVerifiedAt" TIMESTAMP(3);

-- Backfill: an application verified today has been verified at least once.
UPDATE "LawyerClientProfile" SET "firstVerifiedAt" = "verifiedAt" WHERE "verificationStatus" = 'VERIFIED' AND "verifiedAt" IS NOT NULL;
