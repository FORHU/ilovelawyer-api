-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterTable
-- Backfill every existing row as APPROVED (nobody who could already log in
-- gets locked out by this migration) via the column's initial default, then
-- switch that default to PENDING below so only *new* signups start unapproved.
ALTER TABLE "User" ADD COLUMN "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "User" ADD COLUMN "denialReason" TEXT;

ALTER TABLE "User" ALTER COLUMN "approvalStatus" SET DEFAULT 'PENDING';
