-- AlterTable
ALTER TABLE "MessageMindMap" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "MindMapRevision" (
    "id" TEXT NOT NULL,
    "messageMindMapId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "nodeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MindMapRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MindMapRevision_messageMindMapId_version_key" ON "MindMapRevision"("messageMindMapId", "version");

-- AddForeignKey
ALTER TABLE "MindMapRevision" ADD CONSTRAINT "MindMapRevision_messageMindMapId_fkey" FOREIGN KEY ("messageMindMapId") REFERENCES "MessageMindMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;
