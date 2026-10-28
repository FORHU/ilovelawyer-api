-- Client Budget: what a client can spend on a lawyer, set on Create case and shown to matching
-- lawyers in the brief. A low and a high in pence (either can be empty) and the kind of fee the
-- client would rather be quoted (empty: either). Every existing case has no budget.

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "budgetFeePreference" "QuoteType",
ADD COLUMN     "budgetMaxMinor" INTEGER,
ADD COLUMN     "budgetMinMinor" INTEGER;
