ALTER TABLE "Case" ADD COLUMN "actionType" TEXT;
ALTER TABLE "Case" ADD COLUMN "jurisdiction" TEXT;

CREATE TABLE "Party" (
  "id"          TEXT NOT NULL,
  "caseId"      TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "designation" TEXT NOT NULL,
  CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Party_caseId_idx" ON "Party"("caseId");

ALTER TABLE "Party" ADD CONSTRAINT "Party_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
