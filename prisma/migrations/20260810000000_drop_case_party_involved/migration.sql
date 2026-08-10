-- Drop legacy free-text party field; parties live in the Party table.
ALTER TABLE "Case" DROP COLUMN IF EXISTS "partyInvolved";
