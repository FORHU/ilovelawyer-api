-- AlterTable
ALTER TABLE "Document" ADD COLUMN "consultationId" TEXT;

-- CreateIndex
CREATE INDEX "Document_consultationId_idx" ON "Document"("consultationId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
