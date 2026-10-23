-- Solo lawyers work without an organization (docs/adr/0022-solo-lawyers-without-an-organization.md):
-- their calendar, notes, bookmarks, transcriptions, client-request claims and charges carry only
-- the lawyer. A solo lawyer's card for the per-case fee is UserBilling.

-- AlterTable
ALTER TABLE "Bookmark" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ClientRequestClaim" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrganizationCharge" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transcription" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "soloChosenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "events" ALTER COLUMN "organization_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "notes" ALTER COLUMN "organization_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserBilling" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "customerId" TEXT,
    "paymentMethodId" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "setupSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBilling_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserBilling_customerId_key" ON "UserBilling"("customerId");

-- AddForeignKey
ALTER TABLE "UserBilling" ADD CONSTRAINT "UserBilling_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Case and consultation copies can land in a lawyer's own workspace (no organization).
ALTER TABLE "CaseCopy" ALTER COLUMN "targetOrganizationId" DROP NOT NULL;
ALTER TABLE "ConsultationCopy" ALTER COLUMN "targetOrganizationId" DROP NOT NULL;
