-- Additive only: every column is nullable (or a scalar list, which Prisma reads as []),
-- so this ALTER runs on the existing Law table without touching or resetting any data.

-- AlterTable
ALTER TABLE "Law"
  ADD COLUMN "detailFetchedAt" TIMESTAMP(3),
  ADD COLUMN "keywords" TEXT[],
  ADD COLUMN "sections" JSONB,
  ADD COLUMN "keyProvisions" TEXT[],
  ADD COLUMN "dateEnacted" TEXT,
  ADD COLUMN "legislativeAgendaPurpose" TEXT,
  ADD COLUMN "affectedLawsAmendments" TEXT,
  ADD COLUMN "principalAuthors" TEXT,
  ADD COLUMN "coAuthors" TEXT,
  ADD COLUMN "proceduralHistory" TEXT,
  ADD COLUMN "courtReasoning" TEXT,
  ADD COLUMN "legalIssues" TEXT[],
  ADD COLUMN "parties" JSONB,
  ADD COLUMN "judges" JSONB,
  ADD COLUMN "sanctionsAndPenalties" JSONB,
  ADD COLUMN "relatedCasesCited" TEXT[],
  ADD COLUMN "citedGrNumbers" TEXT[],
  ADD COLUMN "citedRaNumbers" TEXT[];
