-- The client app's prices for every tenant that exists now, seeded from the constants they
-- replace (CLIENT_PRICING_DEFAULTS in client-pricing.constants.ts; the tenant seeder adds them to
-- any tenant created later). A separate migration from client_dynamic_pricing: a new enum value
-- (B2C_TOP_UP) can't be used in the transaction that adds it.
INSERT INTO "PaymentPlan" ("id", "tenantId", "planType", "code", "name", "level", "feeUsd", "includedAllowanceUsd", "caseLimit", "isActive", "priceMinor", "credits", "currency", "isDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", p."planType"::"PaymentPlanType", p."code", p."name", p."level", 0, 0, 0, true, p."priceMinor", p."credits", 'USD', p."isDefault", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES
  ('B2C_CASE', 'case', 'Case', 0, 999, 50, false),
  ('B2C_TOP_UP', 'p25', 'Small', 0, 499, 25, false),
  ('B2C_TOP_UP', 'p100', 'Standard', 1, 1499, 100, true),
  ('B2C_TOP_UP', 'p250', 'Large', 2, 2999, 250, false)
) AS p("planType", "code", "name", "level", "priceMinor", "credits", "isDefault")
ON CONFLICT ("tenantId", "planType", "code") DO NOTHING;

INSERT INTO "ClientPromo" ("id", "tenantId", "code", "description", "discountMinor", "currency", "firstCaseOnly", "oncePerClient", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'WELCOME5', '$5 off your first case', 500, 'USD', true, false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
ON CONFLICT ("tenantId", "code") DO NOTHING;
