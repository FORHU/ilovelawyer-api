-- AlterTable
ALTER TABLE "EvidenceContradiction" ADD COLUMN     "leftLocator" TEXT,
ADD COLUMN     "rightLocator" TEXT;

-- CreateTable
CREATE TABLE "FactPairCheck" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "nature" "ContradictionNature" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactPairCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactPairCheck_caseId_pairKey_key" ON "FactPairCheck"("caseId", "pairKey");

-- AddForeignKey
ALTER TABLE "FactPairCheck" ADD CONSTRAINT "FactPairCheck_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

