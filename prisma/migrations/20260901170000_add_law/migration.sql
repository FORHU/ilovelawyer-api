-- CreateEnum
CREATE TYPE "LawCategory" AS ENUM ('JURISPRUDENCE', 'REPUBLIC_ACT');

-- CreateTable
CREATE TABLE "Law" (
    "id" TEXT NOT NULL,
    "jurisSourceId" TEXT NOT NULL,
    "category" "LawCategory" NOT NULL,
    "tenantId" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "tags" TEXT[],
    "caseNumber" TEXT,
    "caseType" TEXT,
    "division" TEXT,
    "ponente" TEXT,
    "decisionDate" TIMESTAMP(3),
    "facts" TEXT,
    "disposition" TEXT,
    "legalRulesCited" TEXT[],
    "raNumber" TEXT,
    "summary" TEXT,
    "jurisUrl" TEXT NOT NULL,
    "pdfUrl" TEXT,
    "sourceUrl" TEXT,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Law_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Law_jurisSourceId_key" ON "Law"("jurisSourceId");

-- CreateIndex
CREATE INDEX "Law_category_tenantId_idx" ON "Law"("category", "tenantId");

-- CreateIndex
CREATE INDEX "Law_year_idx" ON "Law"("year");

-- AddForeignKey
ALTER TABLE "Law" ADD CONSTRAINT "Law_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
