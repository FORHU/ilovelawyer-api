-- DropForeignKey
ALTER TABLE "Case" DROP CONSTRAINT "Case_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_organization_id_fkey";

-- DropIndex
DROP INDEX "CaseDocumentChunk_embedding_hnsw_idx";

-- DropIndex
DROP INDEX "events_organization_id_idx";

-- AlterTable
ALTER TABLE "Case" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
