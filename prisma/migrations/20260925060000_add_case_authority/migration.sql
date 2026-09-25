-- CreateEnum
CREATE TYPE "AuthorityKind" AS ENUM ('STATUTE', 'CASE');

-- CreateEnum
CREATE TYPE "AuthorityStance" AS ENUM ('STATUTE', 'ON_POINT', 'ADVERSE');

-- CreateEnum
CREATE TYPE "AuthoritySource" AS ENUM ('MANUAL', 'AI');

-- CreateTable
CREATE TABLE "CaseAuthority" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "AuthorityKind" NOT NULL,
    "stance" "AuthorityStance" NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "citation" TEXT,
    "rationale" TEXT,
    "findingId" TEXT,
    "resolvedLawId" TEXT,
    "source" "AuthoritySource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseAuthority_caseId_idx" ON "CaseAuthority"("caseId");

-- AddForeignKey
ALTER TABLE "CaseAuthority" ADD CONSTRAINT "CaseAuthority_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAuthority" ADD CONSTRAINT "CaseAuthority_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "CaseFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAuthority" ADD CONSTRAINT "CaseAuthority_resolvedLawId_fkey" FOREIGN KEY ("resolvedLawId") REFERENCES "Law"("id") ON DELETE SET NULL ON UPDATE CASCADE;
