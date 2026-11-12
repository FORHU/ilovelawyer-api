-- Support Chat content (EPIC ilovelawyer-client#120, ilovelawyer-api#639).
-- CreateTable
CREATE TABLE "SupportContentDraft" (
    "id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "basedOnVersion" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportContentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportContentVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackFromVersion" INTEGER,

    CONSTRAINT "SupportContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportContentVersion_version_key" ON "SupportContentVersion"("version");
