-- CreateEnum
CREATE TYPE "CaseLawyerInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "ClientRequestClaim" ADD COLUMN     "lawyerCaseId" TEXT;

-- CreateTable
CREATE TABLE "CaseLawyerInvite" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT,
    "token" TEXT NOT NULL,
    "status" "CaseLawyerInviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseLawyerInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseLawyerInvite_token_key" ON "CaseLawyerInvite"("token");

-- CreateIndex
CREATE INDEX "CaseLawyerInvite_caseId_status_idx" ON "CaseLawyerInvite"("caseId", "status");

-- CreateIndex
CREATE INDEX "CaseLawyerInvite_token_idx" ON "CaseLawyerInvite"("token");

-- AddForeignKey
ALTER TABLE "CaseLawyerInvite" ADD CONSTRAINT "CaseLawyerInvite_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseLawyerInvite" ADD CONSTRAINT "CaseLawyerInvite_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseLawyerInvite" ADD CONSTRAINT "CaseLawyerInvite_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
