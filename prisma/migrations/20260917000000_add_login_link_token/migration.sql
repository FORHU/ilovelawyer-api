-- AlterTable
ALTER TABLE "User" ADD COLUMN "loginLinkToken" TEXT,
ADD COLUMN "loginLinkTokenExpiry" TIMESTAMP(3);
