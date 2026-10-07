-- Case portfolio: a case's creator keeps a copy of it when they leave the organization, and the
-- organization keeps the original.

-- Creator becomes attribution only. Deleting that account used to cascade-delete every case they
-- created, taking them away from the organization too — now the case stays and keeps the name.
ALTER TABLE "Case" ADD COLUMN "createdByName" TEXT;
UPDATE "Case" c SET "createdByName" = COALESCE(NULLIF(u."name", ''), u."username")
FROM "User" u WHERE u."id" = c."userId";

ALTER TABLE "Case" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Case" DROP CONSTRAINT "Case_userId_fkey";
ALTER TABLE "Case" ADD CONSTRAINT "Case_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Where a portfolio copy came from.
ALTER TABLE "Case" ADD COLUMN "copiedFromCaseId" TEXT;
ALTER TABLE "Case" ADD COLUMN "copiedFromOrgName" TEXT;
ALTER TABLE "Case" ADD COLUMN "copiedAt" TIMESTAMP(3);
CREATE INDEX "Case_copiedFromCaseId_idx" ON "Case"("copiedFromCaseId");

-- Copies still to be made, worked through by CaseCopyQueue.
CREATE TYPE "CaseCopyStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE "CaseCopy" (
    "id"                     TEXT NOT NULL,
    "sourceCaseId"           TEXT NOT NULL,
    "caseName"               TEXT NOT NULL,
    "sourceOrganizationName" TEXT NOT NULL,
    "userId"                 TEXT NOT NULL,
    "targetOrganizationId"   TEXT NOT NULL,
    "status"                 "CaseCopyStatus" NOT NULL DEFAULT 'PENDING',
    "copyCaseId"             TEXT,
    "attempts"               INTEGER NOT NULL DEFAULT 0,
    "error"                  TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseCopy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseCopy_userId_status_idx" ON "CaseCopy"("userId", "status");
CREATE INDEX "CaseCopy_status_updatedAt_idx" ON "CaseCopy"("status", "updatedAt");

ALTER TABLE "CaseCopy" ADD CONSTRAINT "CaseCopy_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseCopy" ADD CONSTRAINT "CaseCopy_targetOrganizationId_fkey"
    FOREIGN KEY ("targetOrganizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
