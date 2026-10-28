-- Practice areas move from a hard-coded list (LawyerClientProfile.practiceAreas, codes such as
-- EMPLOYMENT or CIVIL) to rows admins manage, one list per site. The defaults are
-- DEFAULT_PRACTICE_AREAS in src/constants/practice-area.constants.ts, inserted here so every
-- environment has them before existing profiles are mapped onto them.

-- CreateTable
CREATE TABLE "PracticeArea" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "caseArea" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LawyerPracticeArea" (
    "userId" TEXT NOT NULL,
    "practiceAreaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LawyerPracticeArea_pkey" PRIMARY KEY ("userId","practiceAreaId")
);

-- CreateIndex
CREATE INDEX "PracticeArea_country_sortOrder_idx" ON "PracticeArea"("country", "sortOrder");

-- One name per site, whatever its case. Not in schema.prisma: Prisma can't express an index on
-- lower(name). PracticeAreaSvc answers a clash with 409.
CREATE UNIQUE INDEX "PracticeArea_country_name_key" ON "PracticeArea"("country", lower("name"));

-- CreateIndex
CREATE INDEX "LawyerPracticeArea_practiceAreaId_idx" ON "LawyerPracticeArea"("practiceAreaId");

-- AddForeignKey
ALTER TABLE "LawyerPracticeArea" ADD CONSTRAINT "LawyerPracticeArea_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LawyerClientProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LawyerPracticeArea" ADD CONSTRAINT "LawyerPracticeArea_practiceAreaId_fkey" FOREIGN KEY ("practiceAreaId") REFERENCES "PracticeArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The defaults, in picker order.
INSERT INTO "PracticeArea" ("id", "country", "name", "caseArea", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."country", d."name", d."caseArea", true, d."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('UK', 'Family Law', 'FAMILY', 0),
  ('UK', 'Employment Law', 'EMPLOYMENT', 1),
  ('UK', 'Immigration Law', NULL, 2),
  ('UK', 'Criminal Law', NULL, 3),
  ('UK', 'Civil Litigation', 'OTHER', 4),
  ('UK', 'Commercial Litigation', NULL, 5),
  ('UK', 'Corporate Law', NULL, 6),
  ('UK', 'Commercial Law', NULL, 7),
  ('UK', 'Property Law', 'PROPERTY', 8),
  ('UK', 'Real Estate Law', 'PROPERTY', 9),
  ('UK', 'Construction Law', NULL, 10),
  ('UK', 'Contract Law', NULL, 11),
  ('UK', 'Intellectual Property Law', NULL, 12),
  ('UK', 'Data Protection and Privacy Law', NULL, 13),
  ('UK', 'Tax Law', NULL, 14),
  ('UK', 'Banking and Finance Law', NULL, 15),
  ('UK', 'Insolvency and Restructuring', NULL, 16),
  ('UK', 'Wills and Probate', NULL, 17),
  ('UK', 'Human Rights Law', NULL, 18),
  ('UK', 'Public and Administrative Law', NULL, 19),
  ('UK', 'Environmental Law', NULL, 20),
  ('UK', 'Competition Law', NULL, 21),
  ('UK', 'Arbitration and Mediation', NULL, 22),
  ('UK', 'Consumer Law', 'CONSUMER', 23),
  ('UK', 'Insurance Law', NULL, 24),
  ('UK', 'Defamation Law', NULL, 25),
  ('UK', 'Professional Negligence', NULL, 26),
  ('UK', 'International Law', NULL, 27),
  ('PH', 'Family Law', NULL, 0),
  ('PH', 'Labor and Employment Law', NULL, 1),
  ('PH', 'Criminal Law', NULL, 2),
  ('PH', 'Civil Law', NULL, 3),
  ('PH', 'Corporate Law', NULL, 4),
  ('PH', 'Commercial Law', NULL, 5),
  ('PH', 'Property and Real Estate Law', NULL, 6),
  ('PH', 'Immigration Law', NULL, 7),
  ('PH', 'Tax Law', NULL, 8),
  ('PH', 'Intellectual Property Law', NULL, 9),
  ('PH', 'Data Privacy Law', NULL, 10),
  ('PH', 'Cybercrime Law', NULL, 11),
  ('PH', 'Commercial Litigation', NULL, 12),
  ('PH', 'Civil Litigation', NULL, 13),
  ('PH', 'Administrative Law', NULL, 14),
  ('PH', 'Constitutional Law', NULL, 15),
  ('PH', 'Election Law', NULL, 16),
  ('PH', 'Environmental Law', NULL, 17),
  ('PH', 'Banking and Finance Law', NULL, 18),
  ('PH', 'Insurance Law', NULL, 19),
  ('PH', 'Construction Law', NULL, 20),
  ('PH', 'Energy Law', NULL, 21),
  ('PH', 'Maritime and Admiralty Law', NULL, 22),
  ('PH', 'Wills and Estate Settlement', NULL, 23),
  ('PH', 'Arbitration and Mediation', NULL, 24),
  ('PH', 'Consumer Protection Law', NULL, 25),
  ('PH', 'Human Rights Law', NULL, 26),
  ('PH', 'Land Registration and Titling', NULL, 27),
  ('PH', 'Agrarian Reform Law', NULL, 28),
  ('PH', 'Anti-Graft and Corruption Law', NULL, 29)
) AS d("country", "name", "caseArea", "sortOrder");

-- Existing profiles keep what they picked, under the new names. OTHER has no new row, so it's
-- dropped. Verification is left alone, even for a lawyer this leaves with no area: they'll be asked
-- for one the next time they save.
INSERT INTO "LawyerPracticeArea" ("userId", "practiceAreaId", "createdAt")
SELECT DISTINCT p."userId", a."id", CURRENT_TIMESTAMP
FROM "LawyerClientProfile" p
CROSS JOIN LATERAL unnest(p."practiceAreas") AS picked("code")
JOIN (VALUES
  ('UK', 'EMPLOYMENT', 'Employment Law'),
  ('UK', 'PROPERTY', 'Property Law'),
  ('UK', 'FAMILY', 'Family Law'),
  ('UK', 'CONSUMER', 'Consumer Law'),
  ('PH', 'CIVIL', 'Civil Law'),
  ('PH', 'CRIMINAL', 'Criminal Law'),
  ('PH', 'FAMILY', 'Family Law'),
  ('PH', 'LABOR', 'Labor and Employment Law'),
  ('PH', 'CORPORATE', 'Corporate Law'),
  ('PH', 'PROPERTY', 'Property and Real Estate Law'),
  ('PH', 'TAX', 'Tax Law'),
  ('PH', 'IMMIGRATION', 'Immigration Law'),
  ('PH', 'ADMINISTRATIVE', 'Administrative Law')
) AS m("country", "code", "name") ON m."country" = p."country" AND m."code" = picked."code"
JOIN "PracticeArea" a ON a."country" = m."country" AND a."name" = m."name";

-- AlterTable
ALTER TABLE "LawyerClientProfile" DROP COLUMN "practiceAreas";
