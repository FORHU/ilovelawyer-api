-- Client cases are free (ADR 0019): the B2C_CASE row only holds the chat credits a new case starts
-- with, and promo codes now come off a top-up instead of a case.
ALTER TABLE "ClientPromo" RENAME COLUMN "firstCaseOnly" TO "firstTopUpOnly";

-- The case price is no longer charged; zero it so nothing reads a stale amount.
UPDATE "PaymentPlan" SET "priceMinor" = 0 WHERE "planType" = 'B2C_CASE';

-- The seeded WELCOME5 named a case; reword it where an admin hasn't changed it.
UPDATE "ClientPromo" SET "description" = '$5 off your first top-up' WHERE "code" = 'WELCOME5' AND "description" = '$5 off your first case';
