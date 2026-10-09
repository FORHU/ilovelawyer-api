-- Retires the adverse-citation sweep (#380). It lost its only UI when ADR 0016 retired the
-- Citation Map pane, so nothing could run it or show its results. Drops its table, its enums and
-- Case.adverseSweptAt. Weaknesses a lawyer created by accepting a hit are ordinary CaseFinding
-- rows and are kept. This cannot be undone.

-- DropForeignKey
ALTER TABLE "AdverseCitationHit" DROP CONSTRAINT "AdverseCitationHit_caseId_fkey";

-- DropForeignKey
ALTER TABLE "AdverseCitationHit" DROP CONSTRAINT "AdverseCitationHit_citationCheckId_fkey";

-- AlterTable
ALTER TABLE "Case" DROP COLUMN "adverseSweptAt";

-- DropTable
DROP TABLE "AdverseCitationHit";

-- DropEnum
DROP TYPE "AdverseHitKind";

-- DropEnum
DROP TYPE "SuggestionStatus";
