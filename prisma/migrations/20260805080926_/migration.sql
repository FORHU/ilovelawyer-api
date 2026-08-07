/*
  Warnings:

  - You are about to drop the column `aiSummary` on the `UserDocument` table. All the data in the column will be lost.
  - You are about to drop the column `fileUrl` on the `UserDocument` table. All the data in the column will be lost.
  - You are about to drop the column `s3Key` on the `UserDocument` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Transcription" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "UserDocument" DROP COLUMN "aiSummary",
DROP COLUMN "fileUrl",
DROP COLUMN "s3Key",
ADD COLUMN     "fileId" TEXT;

-- AlterTable
ALTER TABLE "events" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
