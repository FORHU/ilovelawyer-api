-- ConsultationTraceEvent: primary key moves from the autoincrement "seq" to a uuid "id", like every
-- other model. "seq" stays as an ordinary autoincrement column (its sequence and values are kept),
-- still used for ordering and as the polling cursor.
--
-- Prisma's generated form (ADD COLUMN "id" TEXT NOT NULL) fails on a table that already has rows,
-- so the column is added nullable, backfilled, and only then made the key. gen_random_uuid() is
-- built in from PostgreSQL 13.

-- AlterTable
ALTER TABLE "ConsultationTraceEvent" ADD COLUMN "id" TEXT;

UPDATE "ConsultationTraceEvent" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;

ALTER TABLE "ConsultationTraceEvent"
  ALTER COLUMN "id" SET NOT NULL,
  DROP CONSTRAINT "ConsultationTraceEvent_pkey",
  ADD CONSTRAINT "ConsultationTraceEvent_pkey" PRIMARY KEY ("id");
