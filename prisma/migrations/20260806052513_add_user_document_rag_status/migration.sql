-- CreateEnum
CREATE TYPE "RagStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "UserDocument" ADD COLUMN     "ragStatus" "RagStatus" NOT NULL DEFAULT 'PENDING';
