-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupOrder" INTEGER,
ADD COLUMN     "groupTitle" TEXT;

-- CreateTable
CREATE TABLE "MessageGroup" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageGroup_consultationId_idx" ON "MessageGroup"("consultationId");

-- CreateIndex
CREATE INDEX "Message_groupId_idx" ON "Message"("groupId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "MessageGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageGroup" ADD CONSTRAINT "MessageGroup_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
