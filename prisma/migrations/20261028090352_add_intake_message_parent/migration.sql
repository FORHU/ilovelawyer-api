-- AlterTable
ALTER TABLE "IntakeMessage" ADD COLUMN     "parentMessageId" TEXT;

-- CreateIndex
CREATE INDEX "IntakeMessage_parentMessageId_idx" ON "IntakeMessage"("parentMessageId");

-- AddForeignKey
ALTER TABLE "IntakeMessage" ADD CONSTRAINT "IntakeMessage_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "IntakeMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
