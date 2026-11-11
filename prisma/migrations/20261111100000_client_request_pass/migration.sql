-- Why a lawyer passed on a client request: the reason and note from the Pass dialog. See
-- ClientRequestPass in schema.prisma.

-- CreateEnum
CREATE TYPE "PassReason" AS ENUM ('CONFLICT', 'CAPACITY', 'OUT_OF_SCOPE', 'FEE_MISMATCH', 'NOT_ENOUGH_INFO', 'OTHER');

-- CreateTable
CREATE TABLE "ClientRequestPass" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lawyerId" TEXT NOT NULL,
    "reason" "PassReason",
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientRequestPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRequestPass_requestId_lawyerId_key" ON "ClientRequestPass"("requestId", "lawyerId");

-- CreateIndex
CREATE INDEX "ClientRequestPass_lawyerId_idx" ON "ClientRequestPass"("lawyerId");

-- AddForeignKey
ALTER TABLE "ClientRequestPass" ADD CONSTRAINT "ClientRequestPass_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRequestPass" ADD CONSTRAINT "ClientRequestPass_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
