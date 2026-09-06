-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('IN_PROGRESS', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "AiGenerationJob" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "AiGenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGenerationJob_subjectId_idx" ON "AiGenerationJob"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "AiGenerationJob_subjectId_kind_key" ON "AiGenerationJob"("subjectId", "kind");
