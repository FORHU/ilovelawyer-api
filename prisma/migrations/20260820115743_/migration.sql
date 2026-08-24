-- DropIndex
DROP INDEX IF EXISTS "CaseDocumentChunk_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "ModelSetting" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "description" TEXT,
    "currentModel" TEXT NOT NULL,
    "availableModels" JSONB NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelSetting_toolName_key" ON "ModelSetting"("toolName");
