-- Differentiation program, Phase 2 (Case Theories & Annotations) — see
-- docs/plans/differentiation-program.md Workstream B.
-- Postgres requires ALTER TYPE ... ADD VALUE to not be used in the same transaction that adds
-- it; nothing else in this migration references 'THEORY', so it's safe in one transaction.
-- AlterEnum
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'THEORY';

-- CreateEnum
CREATE TYPE "TheoryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "TheoryStance" AS ENUM ('ASSERTS', 'DENIES');

-- CreateEnum
CREATE TYPE "AnnotationTargetType" AS ENUM ('NODE', 'EDGE', 'DECISION', 'CHUNK');

-- CreateEnum
CREATE TYPE "AnnotationKind" AS ENUM ('NOTE', 'DISPUTE', 'ALTERNATIVE_READING');

-- CreateTable
CREATE TABLE "CaseTheory" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "title" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "status" "TheoryStatus" NOT NULL DEFAULT 'DRAFT',
    "forkedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseTheory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TheoryClaim" (
    "id" TEXT NOT NULL,
    "theoryId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "stance" "TheoryStance" NOT NULL,
    "graphNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheoryClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TheoryAssumption" (
    "id" TEXT NOT NULL,
    "theoryId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheoryAssumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TheoryOpenQuestion" (
    "id" TEXT NOT NULL,
    "theoryId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheoryOpenQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TheoryDiff" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "theoryAId" TEXT NOT NULL,
    "theoryBId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TheoryDiff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "targetType" "AnnotationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" "AnnotationKind" NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseTheory_caseId_idx" ON "CaseTheory"("caseId");

-- CreateIndex
CREATE INDEX "CaseTheory_caseId_authorUserId_idx" ON "CaseTheory"("caseId", "authorUserId");

-- CreateIndex
CREATE INDEX "TheoryClaim_theoryId_idx" ON "TheoryClaim"("theoryId");

-- CreateIndex
CREATE INDEX "TheoryAssumption_theoryId_idx" ON "TheoryAssumption"("theoryId");

-- CreateIndex
CREATE INDEX "TheoryOpenQuestion_theoryId_idx" ON "TheoryOpenQuestion"("theoryId");

-- CreateIndex
CREATE UNIQUE INDEX "TheoryDiff_theoryAId_theoryBId_key" ON "TheoryDiff"("theoryAId", "theoryBId");

-- CreateIndex
CREATE INDEX "TheoryDiff_caseId_idx" ON "TheoryDiff"("caseId");

-- CreateIndex
CREATE INDEX "Annotation_caseId_idx" ON "Annotation"("caseId");

-- CreateIndex
CREATE INDEX "Annotation_caseId_targetType_targetId_idx" ON "Annotation"("caseId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "CaseTheory" ADD CONSTRAINT "CaseTheory_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TheoryClaim" ADD CONSTRAINT "TheoryClaim_theoryId_fkey" FOREIGN KEY ("theoryId") REFERENCES "CaseTheory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TheoryAssumption" ADD CONSTRAINT "TheoryAssumption_theoryId_fkey" FOREIGN KEY ("theoryId") REFERENCES "CaseTheory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TheoryOpenQuestion" ADD CONSTRAINT "TheoryOpenQuestion_theoryId_fkey" FOREIGN KEY ("theoryId") REFERENCES "CaseTheory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TheoryDiff" ADD CONSTRAINT "TheoryDiff_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
