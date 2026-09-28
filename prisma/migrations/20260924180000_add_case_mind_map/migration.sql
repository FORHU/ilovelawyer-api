-- AlterTable
ALTER TABLE "MindMapRevision" ADD COLUMN     "caseMindMapId" TEXT,
ALTER COLUMN "messageMindMapId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CaseMindMap" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "readySetFingerprint" TEXT,
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseMindMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseMindMap_caseId_key" ON "CaseMindMap"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "MindMapRevision_caseMindMapId_version_key" ON "MindMapRevision"("caseMindMapId", "version");

-- AddForeignKey
ALTER TABLE "MindMapRevision" ADD CONSTRAINT "MindMapRevision_caseMindMapId_fkey" FOREIGN KEY ("caseMindMapId") REFERENCES "CaseMindMap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseMindMap" ADD CONSTRAINT "CaseMindMap_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A revision belongs to exactly one map: a chat message's (MessageMindMap) or a case's
-- (CaseMindMap). Not expressible in schema.prisma, so it lives only here.
ALTER TABLE "MindMapRevision" ADD CONSTRAINT "MindMapRevision_one_owner_check"
  CHECK (("messageMindMapId" IS NULL) <> ("caseMindMapId" IS NULL));
