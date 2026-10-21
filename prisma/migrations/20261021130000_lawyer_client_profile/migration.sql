-- A lawyer's settings for receiving client requests (UK only).
-- CreateEnum
CREATE TYPE "LawyerVerificationStatus" AS ENUM ('UNSUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "LawyerClientProfile" (
    "userId" TEXT NOT NULL,
    "regulator" TEXT,
    "registrationNumber" TEXT,
    "qualifiedJurisdictions" TEXT[],
    "practiceAreas" TEXT[],
    "bio" TEXT NOT NULL DEFAULT '',
    "languages" TEXT[],
    "firstConsultationFeeMinor" INTEGER,
    "acceptingRequests" BOOLEAN NOT NULL DEFAULT false,
    "enabledByOrganization" BOOLEAN NOT NULL DEFAULT true,
    "pausedUntil" TIMESTAMP(3),
    "capacityLimit" INTEGER,
    "verificationStatus" "LawyerVerificationStatus" NOT NULL DEFAULT 'UNSUBMITTED',
    "verificationNote" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LawyerClientProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "LawyerClientProfile_verificationStatus_idx" ON "LawyerClientProfile"("verificationStatus");

-- AddForeignKey
ALTER TABLE "LawyerClientProfile" ADD CONSTRAINT "LawyerClientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

