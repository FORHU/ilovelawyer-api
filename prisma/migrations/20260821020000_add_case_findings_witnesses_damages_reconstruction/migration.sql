-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('LEGAL_ISSUE', 'WEAKNESS', 'STRENGTH', 'ATTACK_STRATEGY', 'DEFENSE_STRATEGY');

-- CreateEnum
CREATE TYPE "DamageCategory" AS ENUM ('ACTUAL', 'MORAL', 'EXEMPLARY', 'ATTORNEYS_FEES', 'OTHER');

-- CreateTable
CREATE TABLE "CaseFinding" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Witness" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "contact" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Witness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DamageClaim" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "category" "DamageCategory" NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DamageClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseReconstruction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseReconstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseFinding_caseId_idx" ON "CaseFinding"("caseId");

-- CreateIndex
CREATE INDEX "CaseFinding_caseId_category_idx" ON "CaseFinding"("caseId", "category");

-- CreateIndex
CREATE INDEX "Witness_caseId_idx" ON "Witness"("caseId");

-- CreateIndex
CREATE INDEX "DamageClaim_caseId_idx" ON "DamageClaim"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseReconstruction_caseId_key" ON "CaseReconstruction"("caseId");

-- AddForeignKey
ALTER TABLE "CaseFinding" ADD CONSTRAINT "CaseFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Witness" ADD CONSTRAINT "Witness_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageClaim" ADD CONSTRAINT "DamageClaim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseReconstruction" ADD CONSTRAINT "CaseReconstruction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
