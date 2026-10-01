-- Damages & Remedies becomes a plain list: kind, title, description, amount, done, due date.
-- Ranges, the rate/percentage calculator, certification status, pending evidence, legal basis,
-- suggested updates and the old Jev columns are dropped. This cannot be undone.

-- CreateEnum
CREATE TYPE "DamageKind" AS ENUM ('DAMAGE', 'REMEDY');

-- AlterTable: new columns
ALTER TABLE "DamageClaim" ADD COLUMN "kind" "DamageKind" NOT NULL DEFAULT 'DAMAGE',
ADD COLUMN "title" TEXT,
ADD COLUMN "done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dueDate" TIMESTAMP(3),
ADD COLUMN "accepted" BOOLEAN NOT NULL DEFAULT true;

-- Every existing row keeps a title: its label, or its category's name.
UPDATE "DamageClaim" SET "title" = COALESCE(NULLIF(TRIM("label"), ''),
  CASE "category"
    WHEN 'ACTUAL' THEN 'Actual damages'
    WHEN 'MORAL' THEN 'Moral damages'
    WHEN 'EXEMPLARY' THEN 'Exemplary damages'
    WHEN 'ATTORNEYS_FEES' THEN 'Attorney''s fees'
    ELSE 'Other'
  END);

-- An AI head nobody had accepted yet (still PROVISIONAL) stays a suggestion.
UPDATE "DamageClaim" SET "accepted" = false WHERE "source" = 'AI' AND "status" = 'PROVISIONAL';

ALTER TABLE "DamageClaim" ALTER COLUMN "title" SET NOT NULL;

-- AlterTable: dropped columns
ALTER TABLE "DamageClaim" DROP COLUMN "category",
DROP COLUMN "label",
DROP COLUMN "basis",
DROP COLUMN "amountLow",
DROP COLUMN "amountHigh",
DROP COLUMN "status",
DROP COLUMN "pendingEvidence",
DROP COLUMN "legalBasis",
DROP COLUMN "aiProposedBasis",
DROP COLUMN "jevSupport",
DROP COLUMN "jevAwardability",
DROP COLUMN "jevConfidence",
DROP COLUMN "jevCheckedAt";

-- DropEnum
DROP TYPE "DamageCategory";
DROP TYPE "DamageStatus";
DROP TYPE "DamageJevSupport";

-- AlterTable: a to-do sent from a damages entry carries its due date
ALTER TABLE "ProcedureItem" ADD COLUMN "dueDate" TIMESTAMP(3);
