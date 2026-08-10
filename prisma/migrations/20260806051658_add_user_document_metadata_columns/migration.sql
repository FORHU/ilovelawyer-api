-- AlterTable
ALTER TABLE "UserDocument" ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "mimeType" TEXT;
