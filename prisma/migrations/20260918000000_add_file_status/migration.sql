-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('FOR_DELETION', 'ACTIVE');

-- AlterTable
ALTER TABLE "File" ADD COLUMN "status" "FileStatus" DEFAULT 'ACTIVE';
