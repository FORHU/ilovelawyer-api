-- LlmUsage (#400, epic #399): one row per LLM call, so spend can be seen per model, feature and
-- organization. Plain append: no foreign keys and no triggers, so usage history outlives the user,
-- organization or case it names. Purely additive; nothing existing changes.

-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('OPENAI', 'TYPESAFE');

-- CreateEnum
CREATE TYPE "LlmUsageSource" AS ENUM ('ESTIMATED', 'REPORTED');

-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" "LlmProvider" NOT NULL,
    "via" TEXT,
    "model" TEXT,
    "feature" TEXT NOT NULL,
    "source" "LlmUsageSource" NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER,
    "totalTokens" INTEGER NOT NULL,
    "passCount" INTEGER,
    "estimatedCostUsd" DOUBLE PRECISION,
    "userId" TEXT,
    "organizationId" TEXT,
    "caseId" TEXT,
    "consultationId" TEXT,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmUsage_createdAt_idx" ON "LlmUsage"("createdAt");

-- CreateIndex
CREATE INDEX "LlmUsage_organizationId_createdAt_idx" ON "LlmUsage"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmUsage_userId_createdAt_idx" ON "LlmUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmUsage_provider_model_idx" ON "LlmUsage"("provider", "model");

-- CreateIndex
CREATE INDEX "LlmUsage_feature_idx" ON "LlmUsage"("feature");

