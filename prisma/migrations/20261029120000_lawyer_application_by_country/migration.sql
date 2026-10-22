-- Lawyer Application by country, firm details, and account setup (onboarding).
-- The registration details an admin checks move out of LawyerClientProfile into one table per
-- country. Existing UK rows are copied across before the old columns go, and existing lawyers are
-- marked as having finished setup, so neither a live database nor its users lose anything.

-- CreateTable
CREATE TABLE "LawyerUkRegistration" (
    "userId" TEXT NOT NULL,
    "regulator" TEXT,
    "registrationNumber" TEXT,
    "qualifiedJurisdictions" TEXT[],

    CONSTRAINT "LawyerUkRegistration_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "LawyerPhRegistration" (
    "userId" TEXT NOT NULL,
    "rollNumber" TEXT,
    "ibpChapter" TEXT,
    "ibpMembershipNumber" TEXT,
    "mcleNumber" TEXT,
    "mclePeriod" TEXT,

    CONSTRAINT "LawyerPhRegistration_pkey" PRIMARY KEY ("userId")
);

-- Every existing profile is a UK one.
INSERT INTO "LawyerUkRegistration" ("userId", "regulator", "registrationNumber", "qualifiedJurisdictions")
SELECT "userId", "regulator", "registrationNumber", "qualifiedJurisdictions" FROM "LawyerClientProfile";

-- DropIndex
DROP INDEX "LawyerClientProfile_verificationStatus_submittedAt_idx";

-- AlterTable
ALTER TABLE "LawyerClientProfile" DROP COLUMN "qualifiedJurisdictions",
DROP COLUMN "registrationNumber",
DROP COLUMN "regulator",
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'UK';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "firmRegistrationNumber" TEXT,
ADD COLUMN     "firmRegulator" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "postcode" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3);

-- Lawyers who signed up before onboarding existed aren't sent through it.
UPDATE "User" SET "setupCompletedAt" = NOW() WHERE "role" = 'LAWYER';

-- CreateIndex
CREATE INDEX "LawyerClientProfile_country_verificationStatus_submittedAt_idx" ON "LawyerClientProfile"("country", "verificationStatus", "submittedAt");

-- AddForeignKey
ALTER TABLE "LawyerUkRegistration" ADD CONSTRAINT "LawyerUkRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LawyerClientProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LawyerPhRegistration" ADD CONSTRAINT "LawyerPhRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LawyerClientProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
