-- A client case's kind of problem moves from one hard-coded code (Case.practiceArea, one of
-- EMPLOYMENT, PROPERTY, FAMILY, CONSUMER, OTHER) to a list of codes (Case.caseAreas) from a table
-- admins manage. The defaults are DEFAULT_CASE_AREAS in src/constants/case-area.constants.ts, with
-- the descriptions Jev was given before; existing cases, and the briefs lawyers read, carry over.

-- CreateTable
CREATE TABLE "CaseArea" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseArea_country_sortOrder_idx" ON "CaseArea"("country", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CaseArea_country_code_key" ON "CaseArea"("country", "code");

-- One name per site, whatever its case. Not in schema.prisma: Prisma can't express an index on
-- lower(name). CaseAreaSvc answers a clash with 409.
CREATE UNIQUE INDEX "CaseArea_country_name_key" ON "CaseArea"("country", lower("name"));

-- The defaults, in picker order.
INSERT INTO "CaseArea" ("id", "country", "code", "name", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'UK', d."code", d."name", d."description", true, d."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('EMPLOYMENT', 'Employment', 'Work, dismissal, pay, discrimination at work.', 0),
  ('PROPERTY', 'Property', 'Renting, landlords, deposits, buying or owning a home, neighbours.', 1),
  ('FAMILY', 'Family', 'Divorce, separation, children.', 2),
  ('CONSUMER', 'Consumer', 'Goods, services, refunds, problems with a business.', 3),
  ('OTHER', 'Other', 'Anything else.', 4)
) AS d("code", "name", "description", "sortOrder");

-- AlterTable: each case keeps the one area it had, now as a list.
ALTER TABLE "Case" ADD COLUMN "caseAreas" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "Case" SET "caseAreas" = ARRAY["practiceArea"] WHERE "practiceArea" IS NOT NULL;
ALTER TABLE "Case" DROP COLUMN "practiceArea";

-- A written brief named its case's area by code (CaseBrief.practiceArea); it now lists the areas
-- by name (CaseBrief.caseAreas), as a lawyer reads them.
UPDATE "ClientRequest"
SET "brief" = ("brief" - 'practiceArea') || jsonb_build_object(
  'caseAreas',
  CASE
    WHEN "brief"->>'practiceArea' IS NULL THEN '[]'::jsonb
    ELSE jsonb_build_array(COALESCE(
      (SELECT a."name" FROM "CaseArea" a WHERE a."country" = 'UK' AND a."code" = "brief"->>'practiceArea'),
      "brief"->>'practiceArea'
    ))
  END
)
WHERE "brief" IS NOT NULL AND "brief" ? 'practiceArea';
