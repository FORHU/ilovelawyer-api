-- CreateTable
CREATE TABLE "MessageGeneratedDocument" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "documentType" TEXT,
    "documentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageGeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageGeneratedDocument_messageId_key" ON "MessageGeneratedDocument"("messageId");

-- AddForeignKey
ALTER TABLE "MessageGeneratedDocument" ADD CONSTRAINT "MessageGeneratedDocument_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageGeneratedDocument" ADD CONSTRAINT "MessageGeneratedDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
