-- What lawyers pay, for every tenant that exists now, seeded from the constants they replace
-- (LAWYER_PRICING_DEFAULTS in lawyer-pricing.constants.ts; the tenant seeder adds them to any tenant
-- created later). A separate migration from lawyer_pricing: a new enum value can't be used in the
-- transaction that adds it.
INSERT INTO "PaymentPlan" ("id", "tenantId", "planType", "code", "name", "level", "feeUsd", "includedAllowanceUsd", "caseLimit", "isActive", "priceMinor", "creditMinor", "currency", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", p."planType"::"PaymentPlanType", p."code", p."name", p."level", 0, 0, 0, true, p."priceMinor", p."creditMinor", 'GBP', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN (VALUES
  ('LAWYER_INTRO_FEE', 'intro', 'Introduction fee', 0, 5000, NULL::integer),
  ('LAWYER_AI_TOP_UP', 'standard', 'Standard', 0, 4000, 2400)
) AS p("planType", "code", "name", "level", "priceMinor", "creditMinor")
ON CONFLICT ("tenantId", "planType", "code") DO NOTHING;
