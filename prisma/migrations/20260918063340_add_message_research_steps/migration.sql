-- CreateTable
CREATE TABLE "MessageResearchSteps" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageResearchSteps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageResearchSteps_messageId_key" ON "MessageResearchSteps"("messageId");

-- AddForeignKey
ALTER TABLE "MessageResearchSteps" ADD CONSTRAINT "MessageResearchSteps_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
