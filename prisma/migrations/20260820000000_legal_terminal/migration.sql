-- NOTE: This migration originally also created its own Organization/OrganizationMember
-- tables (with an OrgRole enum) from before the org-multitenancy feature existed on
-- `add_organizations` (20260817000000). That migration builds the real Organization/
-- OrganizationMember design (slug, OrganizationRole enum, backfill) and already ran
-- first, so the duplicate CREATE TYPE "OrgRole", CREATE TABLE "Organization" /
-- "OrganizationMember", and the duplicate Case.organizationId column/index/FK have been
-- removed from this file to avoid "already exists" failures.

-- CreateEnum
CREATE TYPE "PackageSku" AS ENUM ('SOLO', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "WorkspacePreset" AS ENUM ('PANE_1', 'PANE_2', 'PANE_4', 'PANE_6');

-- CreateEnum
CREATE TYPE "TimelineSource" AS ENUM ('AI', 'LAWYER', 'CALENDAR');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('FATAL', 'MAJOR', 'UNVERIFIED', 'MISSING_EVIDENCE', 'DEADLINE');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'CONFIRMED', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "CasePermission" AS ENUM ('VIEW', 'EDIT', 'ADMIN');

-- CreateEnum
CREATE TYPE "CitationValidityStatus" AS ENUM ('VALID', 'INVALID', 'UNVERIFIED', 'ADVERSE');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('DMS', 'EMAIL', 'CALENDAR', 'EFILING', 'LEGAL_DATABASE');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');

-- AlterTable User
ALTER TABLE "User" ADD COLUMN "packageSku" "PackageSku" NOT NULL DEFAULT 'SOLO';
ALTER TABLE "User" ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT 'en';

-- AlterTable Case
ALTER TABLE "Case" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Case" ADD COLUMN "lastRefreshedAt" TIMESTAMP(3);

-- AlterTable Document
ALTER TABLE "Document" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "Document" ADD COLUMN "pageCount" INTEGER;
ALTER TABLE "Document" ADD COLUMN "extractionMethod" TEXT;
ALTER TABLE "Document" ADD COLUMN "ocrAttempted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable CaseDocumentChunk
ALTER TABLE "CaseDocumentChunk" ADD COLUMN "pageNumber" INTEGER;

-- AlterTable events
ALTER TABLE "events" ADD COLUMN "case_id" TEXT;
ALTER TABLE "events" ADD COLUMN "date_source" TEXT;

-- CreateTable
CREATE TABLE "TerminalWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "preset" "WorkspacePreset" NOT NULL,
    "layoutJson" JSONB NOT NULL,
    "isLastUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseTimelineEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurredOn" TIMESTAMP(3),
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" "TimelineSource" NOT NULL DEFAULT 'LAWYER',
    "documentId" TEXT,
    "chunkId" TEXT,
    "pageNumber" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRisk" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "RiskSeverity" NOT NULL,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "ownerUserId" TEXT,
    "documentId" TEXT,
    "chunkId" TEXT,
    "pageNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceMatrixItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "authenticity" TEXT NOT NULL DEFAULT 'unverified',
    "admissibility" TEXT NOT NULL DEFAULT 'unverified',
    "probative" TEXT NOT NULL DEFAULT 'unverified',
    "originalFile" BOOLEAN NOT NULL DEFAULT true,
    "needsVerify" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceMatrixItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceContradiction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "leftDocumentId" TEXT NOT NULL,
    "rightDocumentId" TEXT NOT NULL,
    "leftExcerpt" TEXT NOT NULL,
    "rightExcerpt" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "leftValue" TEXT NOT NULL,
    "rightValue" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceContradiction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationCheck" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "quotedText" TEXT NOT NULL,
    "citedReference" TEXT,
    "sourceUrl" TEXT,
    "officialText" TEXT,
    "status" "CitationValidityStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "notes" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProceduralDeadline" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "triggerDate" TIMESTAMP(3) NOT NULL,
    "computedDueDate" TIMESTAMP(3) NOT NULL,
    "ruleSource" TEXT NOT NULL,
    "serviceMethod" TEXT,
    "calculationNotes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProceduralDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProceduralDeadlineConfirmation" (
    "id" TEXT NOT NULL,
    "deadlineId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProceduralDeadlineConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcedureItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcedureItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseAccess" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" "CasePermission" NOT NULL DEFAULT 'VIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JurisdictionModule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'en',
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JurisdictionModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConnector" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "type" "ConnectorType" NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TerminalWorkspace_userId_idx" ON "TerminalWorkspace"("userId");
CREATE INDEX "CaseTimelineEvent_caseId_idx" ON "CaseTimelineEvent"("caseId");
CREATE INDEX "CaseTimelineEvent_documentId_idx" ON "CaseTimelineEvent"("documentId");
CREATE INDEX "CaseRisk_caseId_idx" ON "CaseRisk"("caseId");
CREATE INDEX "CaseRisk_ownerUserId_idx" ON "CaseRisk"("ownerUserId");
CREATE UNIQUE INDEX "EvidenceMatrixItem_caseId_documentId_key" ON "EvidenceMatrixItem"("caseId", "documentId");
CREATE INDEX "EvidenceMatrixItem_caseId_idx" ON "EvidenceMatrixItem"("caseId");
CREATE INDEX "EvidenceContradiction_caseId_idx" ON "EvidenceContradiction"("caseId");
CREATE INDEX "CitationCheck_caseId_idx" ON "CitationCheck"("caseId");
CREATE INDEX "ProceduralDeadline_caseId_idx" ON "ProceduralDeadline"("caseId");
CREATE UNIQUE INDEX "ProceduralDeadlineConfirmation_deadlineId_userId_key" ON "ProceduralDeadlineConfirmation"("deadlineId", "userId");
CREATE INDEX "ProceduralDeadlineConfirmation_deadlineId_idx" ON "ProceduralDeadlineConfirmation"("deadlineId");
CREATE INDEX "ProcedureItem_caseId_idx" ON "ProcedureItem"("caseId");
CREATE UNIQUE INDEX "CaseAccess_caseId_userId_key" ON "CaseAccess"("caseId", "userId");
CREATE INDEX "CaseAccess_userId_idx" ON "CaseAccess"("userId");
CREATE INDEX "AuditEvent_caseId_idx" ON "AuditEvent"("caseId");
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");
CREATE UNIQUE INDEX "JurisdictionModule_code_key" ON "JurisdictionModule"("code");
CREATE INDEX "IntegrationConnector_userId_idx" ON "IntegrationConnector"("userId");
CREATE INDEX "IntegrationConnector_organizationId_idx" ON "IntegrationConnector"("organizationId");
CREATE INDEX "events_case_id_idx" ON "events"("case_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TerminalWorkspace" ADD CONSTRAINT "TerminalWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseTimelineEvent" ADD CONSTRAINT "CaseTimelineEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseRisk" ADD CONSTRAINT "CaseRisk_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseRisk" ADD CONSTRAINT "CaseRisk_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvidenceMatrixItem" ADD CONSTRAINT "EvidenceMatrixItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvidenceContradiction" ADD CONSTRAINT "EvidenceContradiction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CitationCheck" ADD CONSTRAINT "CitationCheck_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProceduralDeadline" ADD CONSTRAINT "ProceduralDeadline_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProceduralDeadlineConfirmation" ADD CONSTRAINT "ProceduralDeadlineConfirmation_deadlineId_fkey" FOREIGN KEY ("deadlineId") REFERENCES "ProceduralDeadline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProceduralDeadlineConfirmation" ADD CONSTRAINT "ProceduralDeadlineConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProcedureItem" ADD CONSTRAINT "ProcedureItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseAccess" ADD CONSTRAINT "CaseAccess_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseAccess" ADD CONSTRAINT "CaseAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrationConnector" ADD CONSTRAINT "IntegrationConnector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationConnector" ADD CONSTRAINT "IntegrationConnector_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
