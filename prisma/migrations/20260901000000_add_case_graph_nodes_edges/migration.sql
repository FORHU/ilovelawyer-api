-- CreateEnum
CREATE TYPE "CaseGraphNodeType" AS ENUM ('TIMELINE_EVENT', 'PROCEDURAL_DEADLINE');

-- CreateTable
CREATE TABLE "CaseGraphNode" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "nodeType" "CaseGraphNodeType" NOT NULL,
    "refId" TEXT NOT NULL,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseGraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseGraphEdge" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseGraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseGraphNode_nodeType_refId_key" ON "CaseGraphNode"("nodeType", "refId");

-- CreateIndex
CREATE INDEX "CaseGraphNode_caseId_idx" ON "CaseGraphNode"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseGraphEdge_sourceNodeId_targetNodeId_kind_key" ON "CaseGraphEdge"("sourceNodeId", "targetNodeId", "kind");

-- CreateIndex
CREATE INDEX "CaseGraphEdge_caseId_idx" ON "CaseGraphEdge"("caseId");

-- CreateIndex
CREATE INDEX "CaseGraphEdge_targetNodeId_idx" ON "CaseGraphEdge"("targetNodeId");

-- AddForeignKey
ALTER TABLE "CaseGraphNode" ADD CONSTRAINT "CaseGraphNode_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseGraphEdge" ADD CONSTRAINT "CaseGraphEdge_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseGraphEdge" ADD CONSTRAINT "CaseGraphEdge_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "CaseGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseGraphEdge" ADD CONSTRAINT "CaseGraphEdge_targetNodeId_fkey" FOREIGN KEY ("targetNodeId") REFERENCES "CaseGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
