-- CreateEnum
CREATE TYPE "CaseEdgeRelationType" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CITES', 'PROVES', 'REFUTES', 'SPONSORS');

-- CreateTable
CREATE TABLE "CaseEdge" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "relationType" "CaseEdgeRelationType" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseEdgeArchive" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "relationType" "CaseEdgeRelationType" NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseEdgeArchive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseEdge_caseId_idx" ON "CaseEdge"("caseId");

-- CreateIndex
CREATE INDEX "CaseEdge_targetEntityId_idx" ON "CaseEdge"("targetEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseEdge_sourceEntityId_targetEntityId_relationType_key" ON "CaseEdge"("sourceEntityId", "targetEntityId", "relationType");

-- CreateIndex
CREATE INDEX "CaseEdgeArchive_caseId_idx" ON "CaseEdgeArchive"("caseId");

-- AddForeignKey
ALTER TABLE "CaseEdge" ADD CONSTRAINT "CaseEdge_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEdge" ADD CONSTRAINT "CaseEdge_sourceEntityId_fkey" FOREIGN KEY ("sourceEntityId") REFERENCES "CaseGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEdge" ADD CONSTRAINT "CaseEdge_targetEntityId_fkey" FOREIGN KEY ("targetEntityId") REFERENCES "CaseGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Archive trigger: snapshot a CaseEdge row into CaseEdgeArchive the instant before it is
-- deleted, whether the DELETE targets CaseEdge directly or arrives via the ON DELETE CASCADE
-- from CaseGraphNode/Case above (Postgres fires row-level triggers for cascaded deletes too,
-- so this is the one place that sees every removal path without each caller having to
-- remember to archive).
CREATE FUNCTION archive_case_edge() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO "CaseEdgeArchive" (
        "id", "caseId", "sourceEntityId", "targetEntityId", "relationType", "metadata", "createdAt", "updatedAt"
    ) VALUES (
        OLD."id", OLD."caseId", OLD."sourceEntityId", OLD."targetEntityId", OLD."relationType", OLD."metadata", OLD."createdAt", OLD."updatedAt"
    );
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER case_edge_archive_before_delete
    BEFORE DELETE ON "CaseEdge"
    FOR EACH ROW
    EXECUTE FUNCTION archive_case_edge();
