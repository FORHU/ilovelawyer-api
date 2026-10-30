-- Several lawyers on one request (phase 5): up to 3 lawyers join a routed request, each with their
-- own claim and quote, and the client picks one. The request stays ROUTED until then; CLAIMED and
-- QUOTED are no longer used for it. A request whose first quote is 7 days old with no pick expires.

-- AlterEnum
ALTER TYPE "ClaimOutcome" ADD VALUE 'NOT_CHOSEN';

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "pickByAt" TIMESTAMP(3);

-- A request one lawyer holds today carries on under the new rules: back to ROUTED, its claim still
-- open, and if that lawyer has quoted, the client has 7 days to pick it, counted from the quote or
-- from now, whichever is later: a quote older than 7 days was under no deadline when it was sent,
-- so it mustn't expire on the first sweep after this runs.
UPDATE "ClientRequest" r
SET "pickByAt" = GREATEST(c."quotedAt", now()) + INTERVAL '7 days'
FROM "ClientRequestClaim" c
WHERE c."requestId" = r."id" AND c."outcome" IS NULL AND c."quotedAt" IS NOT NULL AND r."status" IN ('CLAIMED', 'QUOTED');

UPDATE "ClientRequest" SET "status" = 'ROUTED' WHERE "status" IN ('CLAIMED', 'QUOTED');

-- openRequestId held one open claim per request; several can be open now, and the code no longer sets it.
UPDATE "ClientRequestClaim" SET "openRequestId" = NULL WHERE "openRequestId" IS NOT NULL;
